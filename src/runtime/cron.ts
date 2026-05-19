/**
 * In-process cron for Jarvis.
 *
 * Imported by the webhook server, runs alongside it in the same Bun process.
 * Uses simple setInterval with a runtime lock so overlapping invocations
 * cannot stack. For more sophisticated scheduling later, swap for
 * Fly scheduled machines.
 */

import { runScan } from "../modules/scout/scanner.js";
import { runInboxPoll } from "../modules/inbox/watcher.js";
import { runIngestion } from "../modules/memory/index.js";
import { logEvent } from "../modules/scout/db.js";

interface CronJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

const SCOUT_INTERVAL_MS = Number(process.env.SCOUT_INTERVAL_MS ?? 60 * 60 * 1000); // 1 hour default
const INBOX_INTERVAL_MS = Number(process.env.INBOX_INTERVAL_MS ?? 10 * 60 * 1000); // 10 min default
const ZEP_INTERVAL_MS = Number(process.env.ZEP_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min default

const locks = new Map<string, boolean>();

async function runWithLock(job: CronJob): Promise<void> {
  if (locks.get(job.name)) {
    console.log(`[cron] skipping ${job.name}: previous run still in flight`);
    return;
  }
  locks.set(job.name, true);
  const startedAt = Date.now();
  try {
    await job.run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron] ${job.name} failed:`, msg);
    await logEvent("cron", "job_failed", { job: job.name, error: msg }).catch(() => {});
  } finally {
    locks.set(job.name, false);
    const durationMs = Date.now() - startedAt;
    console.log(`[cron] ${job.name} finished in ${durationMs}ms`);
  }
}

const jobs: CronJob[] = [
  {
    name: "scout_scan",
    intervalMs: SCOUT_INTERVAL_MS,
    run: async () => {
      const result = await runScan();
      console.log(
        `[cron] scout_scan: ${result.newJobs} new, ${result.matches.length} matches, ${result.errors.length} errors`
      );
    },
  },
  {
    name: "inbox_poll",
    intervalMs: INBOX_INTERVAL_MS,
    run: async () => {
      const result = await runInboxPoll();
      console.log(
        `[cron] inbox_poll: scanned ${result.messagesScanned}, matched ${result.matches.length}, errors ${result.errors.length}`
      );
    },
  },
  {
    name: "zep_ingestion",
    intervalMs: ZEP_INTERVAL_MS,
    run: async () => {
      const result = await runIngestion();
      console.log(
        `[cron] zep_ingestion: read ${result.eventsRead}, wrote ${result.episodesWritten}, skipped ${result.skipped}, errors ${result.errors.length}`
      );
    },
  },
];

let started = false;

export function startCron(): void {
  if (started) return;
  started = true;

  for (const job of jobs) {
    console.log(`[cron] scheduling ${job.name} every ${(job.intervalMs / 1000 / 60).toFixed(1)} min`);
    // Run once shortly after boot so we don't wait a full hour for the first scan.
    setTimeout(() => void runWithLock(job), 30 * 1000);
    setInterval(() => void runWithLock(job), job.intervalMs);
  }
}

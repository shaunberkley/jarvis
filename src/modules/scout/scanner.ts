/**
 * Scout scanner orchestrator.
 *
 * One run = fan out to all enabled adapters and their watched companies,
 * dedupe new jobs, score them, persist results, and emit NewMatchEvents.
 *
 * Designed to be invoked by:
 *   - The hourly Fly scheduled machine
 *   - The custom Jarvis MCP via /scout-scan-now manual trigger
 *   - Tests
 *
 * The notifier (separate module) consumes NewMatchEvents and pushes to
 * Telegram via the Channels MCP. The scanner doesn't talk to Channels
 * directly so it stays unit-testable without bot infrastructure.
 */

import {
  addBlacklist as _addBlacklist,
  getCriteria,
  getWatchlist,
  isBlacklisted,
  logEvent,
  setJobScore,
  upsertJob,
} from "./db.js";
import { notifyMatches } from "./notifier.js";
import { isHardSkip, scoreJob } from "./scoring.js";
import { getAdapter } from "./sources/index.js";
import type { NewMatchEvent, StoredJob } from "./types.js";

const MATCH_THRESHOLD = 40; // tuned later; jobs >= this surface to Telegram

export interface ScanResult {
  startedAt: Date;
  finishedAt: Date;
  sourcesScanned: number;
  companiesScanned: number;
  jobsSeen: number;
  newJobs: number;
  matches: NewMatchEvent[];
  errors: Array<{ source: string; slug: string; error: string }>;
}

/**
 * Run one scan pass across the entire watchlist.
 */
export async function runScan(): Promise<ScanResult> {
  const startedAt = new Date();
  const result: ScanResult = {
    startedAt,
    finishedAt: startedAt,
    sourcesScanned: 0,
    companiesScanned: 0,
    jobsSeen: 0,
    newJobs: 0,
    matches: [],
    errors: [],
  };

  const [criteria, watchlist] = await Promise.all([getCriteria(), getWatchlist()]);

  // Group by source so we count sources properly.
  const seenSources = new Set<string>();

  for (const entry of watchlist) {
    if (!entry.enabled) continue;
    const adapter = getAdapter(entry.source);
    if (!adapter) continue;

    seenSources.add(entry.source);
    result.companiesScanned += 1;

    let jobs;
    try {
      jobs = await adapter.fetchCompany(entry.companySlug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ source: entry.source, slug: entry.companySlug, error: msg });
      continue;
    }

    for (const job of jobs) {
      result.jobsSeen += 1;

      // Blacklist gate
      if (await isBlacklisted(job.companyName)) {
        continue;
      }

      const { job: stored, isNew } = await upsertJob(job);
      if (!isNew) continue;
      result.newJobs += 1;

      // Score
      const { score, reasons } = scoreJob(job, criteria);
      const status = isHardSkip(score)
        ? "skipped"
        : score >= MATCH_THRESHOLD
          ? "matched"
          : "new";

      await setJobScore(stored.id, isHardSkip(score) ? 0 : score, reasons, status);

      if (status === "matched") {
        result.matches.push({
          jobId: stored.id,
          job: { ...stored, score, reasons, status },
          pickedResume: pickResume(stored),
        });
      }
    }
  }

  result.sourcesScanned = seenSources.size;
  result.finishedAt = new Date();

  // Send notifications for matches. Failures here don't break the scan.
  if (result.matches.length > 0 && process.env.JARVIS_NOTIFY !== "off") {
    try {
      const { sent, failed } = await notifyMatches(result.matches);
      await logEvent("scout", "notify_summary", { sent, failed, total: result.matches.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await logEvent("scout", "notify_error", { error: errMsg });
    }
  }

  await logEvent("scout", "scan_completed", {
    sourcesScanned: result.sourcesScanned,
    companiesScanned: result.companiesScanned,
    jobsSeen: result.jobsSeen,
    newJobs: result.newJobs,
    matchCount: result.matches.length,
    errorCount: result.errors.length,
    durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
  });

  return result;
}

/**
 * Pick the best-fit resume variant for a job.
 *
 * v1: simple keyword routing between main and main-ai variants.
 * v2 (planned): LLM-driven match against the JD with optional tailored generation.
 */
function pickResume(job: StoredJob): string {
  const haystack = `${job.title} ${job.description ?? ""}`.toLowerCase();
  const aiSignals = ["ai", "ml", "agent", "llm", "rag", "generative"];
  const isAiRole = aiSignals.some((s) => haystack.includes(s));
  return isAiRole ? "shaun-berkley-main-ai.pdf" : "shaun-berkley-main.pdf";
}

/**
 * Zep ingestion worker.
 *
 * Reads new rows from the layer 3 event log since the last watermark, shapes
 * each into a Zep episode, and pushes them into the user's graph. The
 * watermark itself is just another row in the events table (type
 * `memory:last_ingested_at`), matching the pattern InboxTriage uses for its
 * own poll cursor. That keeps the events table the single source of truth for
 * worker state and avoids a separate kv table.
 *
 * Failures on individual events are logged to the event log and skipped so a
 * single bad row cannot wedge the worker.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "../scout/db.js";
import { addEpisode, ensureUser } from "./zep-client.js";
import type { Episode, IngestionResult, SourceEvent } from "./types.js";

const STATE_KEY = "memory:last_ingested_at";
const STATE_SOURCE = "memory";
const BATCH_SIZE = 200;

let sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY required");
  sb = createClient(url, key, { auth: { persistSession: false } });
  return sb;
}

/**
 * Event source+type pairs that should never reach Zep. These are either
 * worker bookkeeping (the watermark rows) or pure plumbing signals that
 * carry no episodic value.
 */
const SKIP_KEYS = new Set<string>([
  `${STATE_SOURCE}:${STATE_KEY}`,
  "inbox:inbox:last_polled_at",
  "cron:job_failed",
  "scout:scan_started",
  "telegram:callback_unhandled",
  "telegram:callback_unknown_action",
  "fireflies:webhook_invalid",
  "scout:notify_error",
  "scout:notification_failed",
  "scout:resume_catalog_error",
]);

export async function runIngestion(): Promise<IngestionResult> {
  const startedAt = new Date();
  const result: IngestionResult = {
    startedAt,
    finishedAt: startedAt,
    eventsRead: 0,
    episodesWritten: 0,
    skipped: 0,
    errors: [],
  };

  try {
    await ensureUser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ eventId: "(ensureUser)", error: msg });
    result.finishedAt = new Date();
    return result;
  }

  const since = await getLastIngestedAt();
  const events = await fetchEventsSince(since, BATCH_SIZE);
  result.eventsRead = events.length;

  if (events.length === 0) {
    result.finishedAt = new Date();
    return result;
  }

  let highWater: string | null = null;

  for (const evt of events) {
    const key = `${evt.source}:${evt.type}`;
    if (SKIP_KEYS.has(key)) {
      result.skipped += 1;
      highWater = evt.ts;
      continue;
    }

    const episode = buildEpisode(evt);
    if (!episode) {
      result.skipped += 1;
      highWater = evt.ts;
      continue;
    }

    try {
      await addEpisode(episode);
      result.episodesWritten += 1;
      highWater = evt.ts;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ eventId: evt.id, error: msg });
      await logEvent("memory", "ingest_error", {
        eventId: evt.id,
        source: evt.source,
        type: evt.type,
        error: msg,
      }).catch(() => {});
      // Do not advance highWater past a failed row so the next run retries it.
      break;
    }
  }

  if (highWater) {
    await setLastIngestedAt(new Date(highWater));
  }

  result.finishedAt = new Date();

  await logEvent("memory", "ingest_completed", {
    eventsRead: result.eventsRead,
    episodesWritten: result.episodesWritten,
    skipped: result.skipped,
    errorCount: result.errors.length,
    durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
  }).catch(() => {});

  return result;
}

// ---------------------------------------------------------------------------
// Event -> Episode shaping.
//
// Each case produces a one-sentence narrative body so Zep's entity extractor
// has clean text to work with. Anything that doesn't carry useful episodic
// signal returns null and gets counted as skipped.
// ---------------------------------------------------------------------------

function buildEpisode(evt: SourceEvent): Episode | null {
  const key = `${evt.source}:${evt.type}`;
  const p = evt.payload ?? {};
  const related = evt.related ?? undefined;

  const base = {
    eventId: evt.id,
    occurredAt: evt.ts,
    related,
  };

  switch (key) {
    // -------------------- Scout --------------------
    case "scout:scan_completed": {
      const newJobs = num(p.newJobs);
      const matches = num(p.matchCount ?? p.matches);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.scan_completed",
        body: `Scout scan finished and found ${newJobs} new jobs with ${matches} matches.`,
      };
    }
    case "scout:notify_summary": {
      const count = num(p.count);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.notify_summary",
        body: `Scout sent Shaun a digest of ${count} matching jobs.`,
      };
    }
    case "scout:notification_sent": {
      const title = str(p.title);
      const company = str(p.companyName ?? p.company);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.notification_sent",
        body: `Jarvis notified Shaun about the ${title ?? "role"} at ${company ?? "an unknown company"}.`,
      };
    }
    case "scout:user_approved": {
      const title = str(p.title);
      const company = str(p.companyName ?? p.company);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.user_approved",
        body: `Shaun approved the ${title ?? "role"} at ${company ?? "an unknown company"} and asked Jarvis to apply.`,
      };
    }
    case "scout:user_rejected": {
      const title = str(p.title);
      const company = str(p.companyName ?? p.company);
      const reason = str(p.reason);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.user_rejected",
        body: `Shaun rejected the ${title ?? "role"} at ${company ?? "an unknown company"}${reason ? ` because ${reason}` : ""}.`,
      };
    }
    case "scout:user_snoozed": {
      const title = str(p.title);
      const company = str(p.companyName ?? p.company);
      return {
        ...base,
        kind: "text",
        sourceDescription: "scout.user_snoozed",
        body: `Shaun snoozed the ${title ?? "role"} at ${company ?? "an unknown company"} for later review.`,
      };
    }

    // -------------------- Inbox --------------------
    case "inbox:match": {
      const subject = str(p.subject);
      const fromName = str(p.fromName) ?? str(p.fromEmail);
      const companies = Array.isArray(p.inferredCompanies)
        ? (p.inferredCompanies as string[]).filter(Boolean).join(", ")
        : "";
      const classification = str(p.classification);
      const tail = companies ? ` Possibly related to ${companies}.` : "";
      return {
        ...base,
        kind: "text",
        sourceDescription: "inbox.match",
        body: `Inbox classified an email from ${fromName ?? "an unknown sender"} subject "${subject ?? "(no subject)"}" as ${classification ?? "uncategorized"}.${tail}`,
      };
    }
    case "inbox:link_summary": {
      const linked = num(p.matchesLinked);
      const proposed = num(p.proposedTransitions);
      return {
        ...base,
        kind: "text",
        sourceDescription: "inbox.link_summary",
        body: `Inbox linked ${linked} emails to existing applications and proposed ${proposed} stage transitions.`,
      };
    }
    case "inbox:stage_transition_proposed": {
      const company = str(p.companyName ?? p.company);
      const from = str(p.fromStage);
      const to = str(p.toStage);
      return {
        ...base,
        kind: "text",
        sourceDescription: "inbox.stage_transition_proposed",
        body: `Inbox proposed moving the ${company ?? "(unknown company)"} application from ${from ?? "?"} to ${to ?? "?"}.`,
      };
    }
    case "inbox:poll_completed": {
      const scanned = num(p.messagesScanned);
      const matched = num(p.matchCount);
      if (scanned === 0 && matched === 0) return null;
      return {
        ...base,
        kind: "text",
        sourceDescription: "inbox.poll_completed",
        body: `Inbox poll scanned ${scanned} messages and produced ${matched} matches.`,
      };
    }

    // -------------------- Fireflies --------------------
    case "fireflies:transcript_ingested": {
      const title = str(p.title);
      const participants = Array.isArray(p.participants)
        ? (p.participants as string[]).filter(Boolean).join(", ")
        : "";
      const summary =
        (p.summary && typeof p.summary === "object" && "short_summary" in (p.summary as object)
          ? str((p.summary as Record<string, unknown>).short_summary)
          : undefined) ?? undefined;
      const head = `Fireflies transcript ingested for meeting "${title ?? "(untitled)"}"${participants ? ` with ${participants}` : ""}.`;
      const tail = summary ? ` Summary: ${summary}` : "";
      return {
        ...base,
        kind: "text",
        sourceDescription: "fireflies.transcript_ingested",
        body: head + tail,
      };
    }
    case "fireflies:webhook_received": {
      const meetingId = str(p.meetingId);
      return {
        ...base,
        kind: "text",
        sourceDescription: "fireflies.webhook_received",
        body: `Fireflies notified Jarvis that meeting ${meetingId ?? "(unknown)"} has a transcript ready.`,
      };
    }
    case "fireflies:transcript_not_found": {
      const meetingId = str(p.meetingId);
      return {
        ...base,
        kind: "text",
        sourceDescription: "fireflies.transcript_not_found",
        body: `Fireflies reported transcript missing for meeting ${meetingId ?? "(unknown)"}.`,
      };
    }

    default:
      // Unknown event types are skipped. Future modules can be added above.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function fetchEventsSince(
  since: Date | null,
  limit: number
): Promise<SourceEvent[]> {
  let query = db()
    .from("events")
    .select("id, ts, source, type, payload, related")
    .order("ts", { ascending: true })
    .limit(limit);
  if (since) {
    query = query.gt("ts", since.toISOString());
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    ts: row.ts as string,
    source: row.source as string,
    type: row.type as string,
    payload: (row.payload as Record<string, unknown>) ?? {},
    related: (row.related as string[] | null) ?? null,
  }));
}

async function getLastIngestedAt(): Promise<Date | null> {
  const { data, error } = await db()
    .from("events")
    .select("ts, payload")
    .eq("source", STATE_SOURCE)
    .eq("type", STATE_KEY)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  // Prefer the explicit watermark in payload, fall back to row ts.
  const payload = (data.payload as Record<string, unknown>) ?? {};
  const ingestedAt = typeof payload.ingestedAt === "string" ? payload.ingestedAt : null;
  return ingestedAt ? new Date(ingestedAt) : new Date(data.ts as string);
}

async function setLastIngestedAt(ts: Date): Promise<void> {
  await db().from("events").insert({
    source: STATE_SOURCE,
    type: STATE_KEY,
    payload: { ingestedAt: ts.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Local typing helpers. The events.payload column is jsonb, so we treat
// fields defensively.
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * InboxTriage watcher.
 *
 * Polls Gmail for new messages since the last poll, classifies them, links
 * matches to scout_applications when possible, and writes events. The Telegram
 * notifier picks high-confidence matches for Shaun to triage.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "../scout/db.js";
import { classifyMessage, inferCompanies } from "./classifier.js";
import { getHeader, getMessage, listMessages, parseFrom } from "./gmail.js";
import { linkInboxMatches } from "./linker.js";
import { notifyStageTransitions, type NotifyTransitionContext } from "./notifier.js";
import type { InboxMatch, InboxPollResult } from "./types.js";

const STATE_KEY = "inbox:last_polled_at";

let sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY required");
  sb = createClient(url, key, { auth: { persistSession: false } });
  return sb;
}

export async function runInboxPoll(): Promise<InboxPollResult> {
  const startedAt = new Date();
  const result: InboxPollResult = {
    startedAt,
    finishedAt: startedAt,
    messagesScanned: 0,
    matches: [],
    errors: [],
  };

  const since = await getLastPolledAt();
  const query = buildQuery(since);

  let messages;
  try {
    messages = await listMessages(query, 50);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    result.finishedAt = new Date();
    return result;
  }

  const candidates = await getApplicationCompanyNames();

  for (const summary of messages) {
    result.messagesScanned += 1;
    try {
      const msg = await getMessage(summary.id);
      const fromHeader = getHeader(msg, "From") ?? "";
      const { email: fromEmail, name: fromName } = parseFrom(fromHeader);
      const subject = getHeader(msg, "Subject") ?? "(no subject)";
      const snippet = msg.snippet ?? "";

      const classification = classifyMessage({ fromEmail, subject, snippet });
      const inferredCompanies = inferCompanies({ fromEmail, subject, candidates });

      // Floor: only surface matches above confidence threshold OR with a
      // company match. Everything else gets dropped to keep noise down.
      if (classification.confidence < 0.4 && inferredCompanies.length === 0) continue;

      const match: InboxMatch = {
        gmailId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        fromName,
        subject,
        snippet,
        receivedAt: new Date(Number(msg.internalDate)),
        classification: classification.classification,
        confidence: classification.confidence,
        inferredCompanies,
        reasons: classification.reasons,
      };
      result.matches.push(match);

      await logEvent("inbox", "match", match);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Link matches to scout_applications and surface proposed stage transitions.
  if (result.matches.length > 0) {
    try {
      const linkResult = await linkInboxMatches(result.matches);
      await logEvent("inbox", "link_summary", {
        matchesLinked: linkResult.matched,
        proposedTransitions: linkResult.proposedTransitions.length,
      });

      // Notify Shaun about proposed transitions. Notifier failures must not
      // break the poll, so wrap in try/catch and log separately.
      if (linkResult.proposedTransitions.length > 0 && process.env.JARVIS_NOTIFY !== "off") {
        try {
          const context: Record<string, NotifyTransitionContext> = {};
          for (const m of result.matches) {
            context[m.gmailId] = { subject: m.subject, snippet: m.snippet };
          }
          const { sent, failed } = await notifyStageTransitions(
            linkResult.proposedTransitions,
            context
          );
          await logEvent("inbox", "notify_summary", {
            sent,
            failed,
            total: linkResult.proposedTransitions.length,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await logEvent("inbox", "notify_error", { error: errMsg });
        }
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await setLastPolledAt(startedAt);
  result.finishedAt = new Date();

  await logEvent("inbox", "poll_completed", {
    messagesScanned: result.messagesScanned,
    matchCount: result.matches.length,
    errorCount: result.errors.length,
    durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
  });

  return result;
}

function buildQuery(since: Date | null): string {
  // Gmail search query syntax: https://support.google.com/mail/answer/7190
  // We want: only inbox, only unread (saves work), and bounded by last poll.
  const parts: string[] = ["in:inbox"];
  if (since) {
    const seconds = Math.floor(since.getTime() / 1000);
    parts.push(`after:${seconds}`);
  }
  return parts.join(" ");
}

async function getApplicationCompanyNames(): Promise<string[]> {
  const { data, error } = await db()
    .from("scout_jobs")
    .select("company_name")
    .in("status", ["matched", "applied"]);
  if (error) throw error;
  const set = new Set((data ?? []).map((r) => r.company_name as string));
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Last-polled state. Stored as a single row in the events table with a known
// type so we don't need a separate kv table just for this.
// ---------------------------------------------------------------------------

async function getLastPolledAt(): Promise<Date | null> {
  const { data, error } = await db()
    .from("events")
    .select("ts")
    .eq("source", "inbox")
    .eq("type", STATE_KEY)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data ? new Date(data.ts as string) : null;
}

async function setLastPolledAt(ts: Date): Promise<void> {
  // Append rather than upsert. Keeps an audit trail; getLastPolledAt only
  // reads the most recent.
  await db().from("events").insert({
    source: "inbox",
    type: STATE_KEY,
    payload: { polledAt: ts.toISOString() },
  });
}

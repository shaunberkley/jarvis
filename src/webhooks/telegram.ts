/**
 * Telegram callback webhook handler.
 *
 * Telegram POSTs an Update object whenever the user presses an inline button
 * or sends a message. For Jarvis, the bot itself runs through the official
 * Claude Code Channels MCP (handles incoming text). This webhook handles
 * Scout's inline button presses (thumbs up/down/snooze) which the Channels
 * MCP doesn't surface directly.
 *
 * Setup: register this URL with Telegram via setWebhook ONCE per deployment:
 *   curl -F "url=https://jarvis-shaun.fly.dev/webhooks/telegram" \
 *        -F "allowed_updates=[\"callback_query\"]" \
 *        https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook
 */

import { Hono } from "hono";
import { logEvent } from "../modules/scout/db.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApplicationStage } from "../modules/scout/types.js";

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: { text?: string; chat?: { id: number } };
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

const TELEGRAM_API = "https://api.telegram.org";

export const telegramApp = new Hono();

telegramApp.post("/webhooks/telegram", async (c) => {
  const update = (await c.req.json()) as TelegramUpdate;

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }

  // Telegram requires a 200 response within ~30 seconds or it retries.
  // Always ack fast; do real work async if needed.
  return c.json({ ok: true });
});

async function handleCallback(cb: TelegramCallbackQuery): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const data = cb.data ?? "";

  // Acknowledge first so the spinner stops on the user's phone.
  await answerCallback(token, cb.id, parseToast(data));

  const parts = data.split(":");
  const namespace = parts[0];

  if (namespace === "scout") {
    await handleScoutCallback(token, cb, parts);
    return;
  }

  if (namespace === "inbox") {
    await handleInboxCallback(token, cb, parts);
    return;
  }

  await logEvent("telegram", "callback_unhandled", { data });
}

async function handleScoutCallback(
  token: string,
  cb: TelegramCallbackQuery,
  parts: string[]
): Promise<void> {
  // Callback data format: "scout:<action>:<jobId>"
  const [, action, jobId] = parts;
  if (!action || !jobId) {
    await logEvent("telegram", "callback_unhandled", { data: parts.join(":") });
    return;
  }

  switch (action) {
    case "apply":
      await markJobStatus(jobId, "matched"); // queued for application; auto-apply TBD
      await logEvent("scout", "user_approved", { jobId, userId: cb.from.id }, [jobId]);
      await editMessageNote(token, cb.message, "✅ Queued for application");
      break;

    case "skip":
      await markJobStatus(jobId, "skipped");
      await logEvent("scout", "user_rejected", { jobId, userId: cb.from.id }, [jobId]);
      await editMessageNote(token, cb.message, "👎 Skipped");
      break;

    case "snooze":
      await logEvent("scout", "user_snoozed", { jobId, userId: cb.from.id }, [jobId]);
      await editMessageNote(token, cb.message, "⏸ Snoozed");
      break;

    default:
      await logEvent("telegram", "callback_unknown_action", { data: parts.join(":") });
  }
}

async function handleInboxCallback(
  token: string,
  cb: TelegramCallbackQuery,
  parts: string[]
): Promise<void> {
  // Callback data format: "inbox:transition:<action>:<applicationId>"
  const [, kind, action, applicationId] = parts;
  if (kind !== "transition" || !action || !applicationId) {
    await logEvent("telegram", "callback_unhandled", { data: parts.join(":") });
    return;
  }

  switch (action) {
    case "accept": {
      const proposedStage = await getProposedStageFor(applicationId);
      if (!proposedStage) {
        await logEvent(
          "inbox",
          "stage_accept_failed",
          {
            applicationId,
            userId: cb.from.id,
            reason: "no_proposed_stage_event_found",
          },
          [applicationId]
        );
        await editMessageNote(token, cb.message, "⚠️ Could not find proposed stage");
        return;
      }
      try {
        await updateApplicationStage(applicationId, proposedStage);
        await logEvent(
          "inbox",
          "stage_accepted",
          {
            applicationId,
            stage: proposedStage,
            userId: cb.from.id,
          },
          [applicationId]
        );
        await editMessageNote(token, cb.message, `✅ Accepted: ${proposedStage}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await logEvent(
          "inbox",
          "stage_accept_failed",
          { applicationId, userId: cb.from.id, error: errMsg },
          [applicationId]
        );
        await editMessageNote(token, cb.message, "⚠️ Update failed");
      }
      break;
    }

    case "reject":
      await logEvent(
        "inbox",
        "stage_rejected",
        { applicationId, userId: cb.from.id },
        [applicationId]
      );
      await editMessageNote(token, cb.message, "❌ Rejected");
      break;

    case "edit":
      await logEvent(
        "inbox",
        "stage_edit_requested",
        {
          applicationId,
          userId: cb.from.id,
          note: "manual review needed",
        },
        [applicationId]
      );
      await editMessageNote(token, cb.message, "✏️ Manual review queued");
      break;

    default:
      await logEvent("telegram", "callback_unknown_action", { data: parts.join(":") });
  }
}

function parseToast(data: string): string {
  if (data.includes(":apply:")) return "Queued for application";
  if (data.includes(":skip:")) return "Skipped";
  if (data.includes(":snooze:")) return "Snoozed";
  if (data.includes("inbox:transition:accept:")) return "Accepted";
  if (data.includes("inbox:transition:reject:")) return "Rejected";
  if (data.includes("inbox:transition:edit:")) return "Manual review queued";
  return "Got it";
}

async function answerCallback(token: string, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {}); // ack failures are non-fatal
}

async function editMessageNote(
  token: string,
  message: TelegramCallbackQuery["message"],
  note: string
): Promise<void> {
  if (!message) return;
  // Append a note line by editing the reply markup; safest is to remove the
  // buttons and add a single status button so the original message stays readable.
  await fetch(`${TELEGRAM_API}/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: {
        inline_keyboard: [[{ text: note, callback_data: "noop" }]],
      },
    }),
  }).catch(() => {});
}

async function markJobStatus(jobId: string, status: string): Promise<void> {
  const sb = getDb();
  const { error } = await sb.from("scout_jobs").update({ status }).eq("id", jobId);
  if (error) throw error;
}

/**
 * Look up the proposed stage for an application from the most recent
 * stage_transition_proposed event the inbox linker emitted. We query by
 * source + type and filter on related[] containing the application id; the
 * payload carries the proposedStage value.
 */
async function getProposedStageFor(applicationId: string): Promise<ApplicationStage | null> {
  const sb = getDb();
  const { data, error } = await sb
    .from("events")
    .select("payload")
    .eq("source", "inbox")
    .eq("type", "stage_transition_proposed")
    .contains("related", [applicationId])
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const payload = data.payload as { proposedStage?: string } | null;
  const stage = payload?.proposedStage;
  return stage ? (stage as ApplicationStage) : null;
}

async function updateApplicationStage(
  applicationId: string,
  stage: ApplicationStage
): Promise<void> {
  const sb = getDb();
  const { error } = await sb
    .from("scout_applications")
    .update({ current_stage: stage, updated_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw error;
}

let cachedDb: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (cachedDb) return cachedDb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY required");
  cachedDb = createClient(url, key, { auth: { persistSession: false } });
  return cachedDb;
}

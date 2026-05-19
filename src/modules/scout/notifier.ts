/**
 * Scout Telegram notifier.
 *
 * Sends formatted match notifications directly via the Telegram Bot API.
 * Does NOT route through the Claude Code session — outbound notifications
 * don't need LLM reasoning, and bypassing the session keeps notifications
 * reliable even if the session is mid-task.
 *
 * Inline buttons let Shaun thumbs-up / thumbs-down each match from the
 * Telegram chat. Button presses come back as callback queries to the
 * /webhooks/telegram endpoint.
 */

import { logEvent } from "./db.js";
import type { NewMatchEvent } from "./types.js";

const TELEGRAM_API = "https://api.telegram.org";

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface SendMessageResponse {
  ok: boolean;
  result?: { message_id: number; chat: { id: number } };
  description?: string;
}

export async function notifyMatches(matches: NewMatchEvent[]): Promise<{ sent: number; failed: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  if (!token || !chatIdsRaw) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS must be set");
  }
  // First allowed chat id is treated as the primary destination for notifications.
  const chatId = chatIdsRaw.split(",")[0]?.trim();
  if (!chatId) throw new Error("No chat id parsed from TELEGRAM_ALLOWED_CHAT_IDS");

  let sent = 0;
  let failed = 0;

  for (const match of matches) {
    try {
      const message_id = await sendMatchMessage(token, chatId, match);
      sent += 1;
      await logEvent("scout", "notification_sent", {
        jobId: match.jobId,
        telegramMessageId: message_id,
      }, [match.jobId]);
    } catch (err) {
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      await logEvent("scout", "notification_failed", { jobId: match.jobId, error: errMsg }, [match.jobId]);
    }
  }

  return { sent, failed };
}

async function sendMatchMessage(
  token: string,
  chatId: string,
  match: NewMatchEvent
): Promise<number> {
  const text = formatMatchMessage(match);
  const reply_markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "👍 Apply", callback_data: `scout:apply:${match.jobId}` },
        { text: "👎 Skip", callback_data: `scout:skip:${match.jobId}` },
      ],
      [
        { text: "🔗 View posting", url: match.job.url },
        { text: "⏸ Snooze", callback_data: `scout:snooze:${match.jobId}` },
      ],
    ],
  };

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: false,
      reply_markup,
    }),
  });
  const body = (await res.json()) as SendMessageResponse;
  if (!body.ok || !body.result) {
    throw new Error(`Telegram sendMessage failed: ${body.description ?? res.statusText}`);
  }
  return body.result.message_id;
}

function formatMatchMessage(match: NewMatchEvent): string {
  const j = match.job;
  const lines: string[] = [];

  // Header
  lines.push(`🎯 *New match: ${escapeMd(j.title)}*`);
  lines.push(`_${escapeMd(j.companyName)}_ \\| score *${j.score ?? "?"}/100*`);

  // Comp
  if (j.compMin != null || j.compMax != null) {
    const lo = j.compMin != null ? `$${(j.compMin / 1000).toFixed(0)}k` : "?";
    const hi = j.compMax != null ? `$${(j.compMax / 1000).toFixed(0)}k` : "?";
    lines.push(`💵 ${escapeMd(`${lo}–${hi}`)} base`);
  } else {
    lines.push("💵 comp not disclosed");
  }

  // Location / remote
  if (j.remote === true) {
    lines.push(`🌎 Remote${j.location ? ` \\(${escapeMd(j.location)}\\)` : ""}`);
  } else if (j.location) {
    lines.push(`🌎 ${escapeMd(j.location)}`);
  }

  // Top reasons (positives)
  const topReasons = (j.reasons?.positives ?? []).slice(0, 4);
  if (topReasons.length > 0) {
    lines.push("");
    lines.push("*Why it matched:*");
    for (const reason of topReasons) {
      lines.push(`• ${escapeMd(reason)}`);
    }
  }

  // Negatives (if any)
  const negatives = (j.reasons?.negatives ?? []).slice(0, 2);
  if (negatives.length > 0) {
    lines.push("");
    lines.push("*Caveats:*");
    for (const neg of negatives) {
      lines.push(`• ${escapeMd(neg)}`);
    }
  }

  // Resume picked
  lines.push("");
  lines.push(`📄 Suggested resume: \`${escapeMd(match.pickedResume)}\``);

  // Source
  lines.push(`🔗 via *${escapeMd(j.source)}*`);

  return lines.join("\n");
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

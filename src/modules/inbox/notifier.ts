/**
 * InboxTriage Telegram notifier.
 *
 * Sends proposed stage transitions to Telegram with inline buttons so Shaun
 * can accept, edit, or reject each one. Mirrors the Scout notifier pattern:
 * direct Telegram Bot API calls, MarkdownV2 formatting, and event logging
 * for every send / failure.
 */

import { logEvent } from "../scout/db.js";
import type { LinkResult } from "./linker.js";

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

export type ProposedTransition = LinkResult["proposedTransitions"][number];

export interface NotifyTransitionContext {
  subject?: string;
  snippet?: string;
}

/**
 * Send one Telegram message per proposed stage transition. Each message
 * carries inline buttons for accept / edit / reject, routed via the
 * inbox:transition callback namespace.
 */
export async function notifyStageTransitions(
  transitions: ProposedTransition[],
  context?: Record<string, NotifyTransitionContext>
): Promise<{ sent: number; failed: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  if (!token || !chatIdsRaw) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS must be set");
  }
  const chatId = chatIdsRaw.split(",")[0]?.trim();
  if (!chatId) throw new Error("No chat id parsed from TELEGRAM_ALLOWED_CHAT_IDS");

  let sent = 0;
  let failed = 0;

  for (const transition of transitions) {
    try {
      const ctx = context?.[transition.inboxEventGmailId];
      const message_id = await sendTransitionMessage(token, chatId, transition, ctx);
      sent += 1;
      await logEvent(
        "inbox",
        "notification_sent",
        {
          applicationId: transition.applicationId,
          gmailId: transition.inboxEventGmailId,
          telegramMessageId: message_id,
        },
        [transition.applicationId]
      );
    } catch (err) {
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      await logEvent(
        "inbox",
        "notification_failed",
        {
          applicationId: transition.applicationId,
          gmailId: transition.inboxEventGmailId,
          error: errMsg,
        },
        [transition.applicationId]
      );
    }
  }

  return { sent, failed };
}

async function sendTransitionMessage(
  token: string,
  chatId: string,
  transition: ProposedTransition,
  ctx?: NotifyTransitionContext
): Promise<number> {
  const text = formatTransitionMessage(transition, ctx);
  const reply_markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: "✅ Accept",
          callback_data: `inbox:transition:accept:${transition.applicationId}`,
        },
        {
          text: "✏️ Edit",
          callback_data: `inbox:transition:edit:${transition.applicationId}`,
        },
        {
          text: "❌ Reject",
          callback_data: `inbox:transition:reject:${transition.applicationId}`,
        },
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
      disable_web_page_preview: true,
      reply_markup,
    }),
  });
  const body = (await res.json()) as SendMessageResponse;
  if (!body.ok || !body.result) {
    throw new Error(`Telegram sendMessage failed: ${body.description ?? res.statusText}`);
  }
  return body.result.message_id;
}

function formatTransitionMessage(
  transition: ProposedTransition,
  ctx?: NotifyTransitionContext
): string {
  const lines: string[] = [];

  lines.push(`📬 *Stage transition proposed: ${escapeMd(transition.company)}*`);
  lines.push(
    `${escapeMd(transition.currentStage)} → *${escapeMd(transition.proposedStage)}*`
  );

  lines.push("");
  lines.push("*Rationale:*");
  lines.push(escapeMd(transition.rationale));

  if (ctx?.subject) {
    lines.push("");
    lines.push("*Email subject:*");
    lines.push(escapeMd(ctx.subject));
  }

  if (ctx?.snippet) {
    const snippet = ctx.snippet.length > 280 ? `${ctx.snippet.slice(0, 280)}...` : ctx.snippet;
    lines.push("");
    lines.push("*Snippet:*");
    lines.push(`_${escapeMd(snippet)}_`);
  }

  lines.push("");
  lines.push(`gmail id: \`${escapeMd(transition.inboxEventGmailId)}\``);
  lines.push(`application: \`${escapeMd(transition.applicationId)}\``);

  return lines.join("\n");
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

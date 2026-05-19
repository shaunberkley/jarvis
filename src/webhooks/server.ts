/**
 * Inbound webhook server for Jarvis.
 *
 * Listens on :3000 (mapped to https through Fly). Handles:
 *   - POST /webhooks/fireflies   Fireflies transcript-ready events
 *   - POST /webhooks/linear      Linear ticket events (optional)
 *   - GET  /health               Liveness check for Fly
 *
 * Webhook handlers transform incoming events into structured payloads and
 * push them into the running Claude Code session via the Channels MCP, which
 * surfaces them in Telegram as a thread for Shaun to review.
 */

import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "jarvis", version: "0.1.0" }));

app.post("/webhooks/fireflies", async (c) => {
  const signature = c.req.header("x-fireflies-signature");
  // TODO: verify signature against FIREFLIES_WEBHOOK_SECRET
  const body = await c.req.json();

  // TODO: dispatch to src/modules/meeting/handler.ts
  // For now, just log and ack so the webhook endpoint is exercisable.
  console.log("[jarvis] fireflies webhook received:", JSON.stringify(body).slice(0, 500));

  return c.json({ ok: true });
});

app.post("/webhooks/linear", async (c) => {
  const body = await c.req.json();
  console.log("[jarvis] linear webhook received:", JSON.stringify(body).slice(0, 500));
  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);

console.log(`[jarvis] webhook server listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};

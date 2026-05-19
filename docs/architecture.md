# Jarvis Architecture

## High level

Jarvis is a long-lived Claude Code session that runs on a personal Fly.io VM, controlled from Shaun's phone via Telegram. The session has a fixed MCP config loaded at startup, which includes:

- The official Claude Code Channels MCP (Telegram bridge, March 2026)
- Integration MCPs (Fireflies, Gmail, Calendar, Linear, Supabase, Browserbase, Zep)
- A custom Jarvis MCP exposing `/jarvis-*` slash commands as tools

When Shaun sends a message in Telegram, Channels forwards it into the running Claude Code session. Claude interprets the message, calls whichever MCP tools are needed, and replies back through Channels to the same Telegram thread.

Inbound events (Fireflies transcript-ready, scheduled cron triggers, recruiter email arrivals) come in through the webhook server running on the same VM at `:3000`, which dispatches into module handlers. Those handlers push events into the Claude Code session so Shaun sees them as Telegram messages.

## Why a single long-lived session

- One conversational thread for everything Shaun does with Jarvis
- One memory context that all modules share
- One Claude Max subscription powering it (reused from Bob's existing auth token)
- Simple operational model: if the VM is up, Jarvis is up

## Permissions

The session runs with `--dangerously-skip-permissions`. This is required for autonomous operation. The tradeoff is that Jarvis can take any action its tools allow without prompting. We mitigate this by:

- Tools that perform irreversible actions (sending email, submitting applications, deleting calendar events) include explicit confirmation prompts to Telegram before they execute
- Sensitive secrets (Claude OAuth token, API keys) are mounted as Fly secrets and never written to git

## Infrastructure

| Layer | Tech | Why |
|---|---|---|
| Compute | Fly.io VM (personal account, separate from DriveClub) | Already used for Bob; reliable; per-VM secrets |
| Runtime | Claude Code CLI on the VM | Subscription billing instead of API costs |
| Comms | Telegram via Claude Code Channels MCP | Free forever, no message expiration, official Anthropic plugin |
| Memory | Zep (cloud free tier → self-hosted Docker fallback) | Temporal knowledge graph fits evolving personal state |
| State | Supabase Postgres (personal project) | ACID for transactional state; free tier sufficient |
| Browser | Browserbase | Persistent sessions for logged-in scraping; free tier 60 hours/mo |
| Webhooks | Hono on port 3000 | Lightweight, runs in the same Bun process |

## Module boundary

Each module under `src/modules/` is responsible for one cohesive surface (job hunting, meetings, inbox, calendar). Modules expose MCP tools through the custom Jarvis MCP server. They share state through Supabase and Zep but do not import each other directly.

## Operational notes

- Logs go to Fly's centralized log stream; tail with `fly logs -a jarvis-shaun`
- Persistent volume at `/data` survives VM restarts
- Health endpoint at `/health` for Fly's checks
- Zero secrets in git; all set via `fly secrets set` once and forgotten

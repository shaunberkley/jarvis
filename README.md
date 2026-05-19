# Jarvis

A personal AI assistant for Shaun. Runs as a long-lived Claude Code session on a personal Fly.io VM, controlled via Telegram, with episodic memory backed by Zep.

Jarvis is modular. The first module is Scout (job hunting). Future modules cover meetings, inbox triage, calendar, and general memory query.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Telegram (personal phone)                               │
│  ↕ Claude Code Channels MCP (official Anthropic)         │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  Fly.io personal VM                                      │
│  Long-lived Claude Code session                          │
│  claude --dangerously-skip-permissions                   │
│         --mcp-config /etc/jarvis/mcp.json                │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬─────┘
   │      │      │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼
 Channels Fireflies Gmail Cal Linear Supa Browserbase Zep   Custom-Jarvis MCP
                                                            (slash commands)
```

## Runtime

```
claude --dangerously-skip-permissions \
       --mcp-config /etc/jarvis/mcp.json
```

Single long-lived session. The `--dangerously-skip-permissions` flag auto-approves tool calls so Jarvis acts immediately on Telegram messages without prompting for approval.

Authentication: Jarvis reuses Bob's Claude login token (mounted from a Fly secret), so it runs under the same Claude Max subscription with zero additional cost.

## Comms

**Telegram only.** Single channel for everything.

- Free forever, no message expiration (unlike Slack Free's 90-day cap)
- Official Anthropic Claude Code Channels plugin (March 2026)
- Mobile-first, which fits the personal-assistant shape

Custom slash commands live as tools in the custom Jarvis MCP server. Invoking `/jarvis-status` in Telegram routes through Channels into the Claude Code session, which calls the corresponding MCP tool.

## Modules

Each module is a directory under `src/modules/`. Modules run as long-lived MCP-exposed tools or as webhook handlers. They share state through the canonical Supabase Postgres database and the Zep memory layer.

| Module | Purpose | Status |
|---|---|---|
| **Scout** | Hourly scan of LinkedIn + Ashby/Greenhouse/Lever, auto-apply to matches, recruiter inbox triage | planned |
| **MeetingMemory** | Fireflies webhook → extract structured episode → Zep, push action items to Linear | planned |
| **InboxTriage** | Gmail watch, classify recruiter / important / noise, draft replies | planned |
| **CalendarOps** | Proactive scheduling, conflict detection, meeting prep digest | planned |
| **MemoryQuery** | Ask Jarvis "what did we decide last week with X?" across all episodes | planned |

## Memory

Episodic memory uses **Zep** for temporal knowledge graph storage. Why Zep:
- Timestamps every fact with a validity window. When state changes (job moves from "applied" to "interview"), the old fact is superseded with an end date instead of overwritten.
- Scored 63.8% on LongMemEval vs Mem0's 49.0% in 2026 benchmarks.
- Free tier covers initial usage. Falls back to self-hosted Docker on the Fly VM if cap is hit.

See `docs/memory.md` for the schema and access patterns.

## Cost

- Telegram: $0 (free forever)
- Fly.io personal VM: ~$15-25/mo
- Claude Code Max: $0 incremental (reuses Bob's existing subscription)
- Supabase free tier: $0 (up to 500MB)
- Zep Cloud free tier: $0 initially, self-host if cap is hit
- Browserbase free tier: $0 (60 hours/mo)

**Total monthly: $15-25**, sharing the existing Claude Max subscription.

## Setup

Stub instructions; full setup added once the scaffold is exercised end-to-end.

```bash
# Clone
git clone https://github.com/shaunberkley/jarvis.git
cd jarvis

# Install dependencies
bun install

# Copy env template
cp .env.example .env
# Fill in: TELEGRAM_BOT_TOKEN, FIREFLIES_API_KEY, GMAIL_*, ZEP_API_KEY, SUPABASE_*, BROWSERBASE_API_KEY

# Local dev
bun run dev

# Deploy
fly deploy
```

## Repository layout

```
jarvis/
├── README.md
├── LICENSE
├── Dockerfile          # Runtime image: Node/Bun + Claude Code CLI
├── fly.toml            # Personal Fly app config
├── docs/
│   ├── architecture.md
│   ├── memory.md
│   └── modules.md
├── config/
│   ├── mcp.json        # MCP server registry loaded at startup
│   └── jarvis.toml     # Jarvis runtime settings
├── src/
│   ├── mcp/            # Custom Jarvis MCP server (slash commands)
│   ├── modules/        # Per-module logic (Scout, MeetingMemory, etc.)
│   ├── runtime/        # Entry shell scripts
│   └── webhooks/       # Inbound webhook handlers (Fireflies, etc.)
├── scripts/
│   └── deploy.sh
└── tests/
```

## Status

Pre-alpha. Scaffolding stage. Not deployed yet.

---

Built by [Shaun Berkley](https://github.com/shaunberkley). Sibling to [Bob](https://github.com/shaunberkley) (autonomous code review) and Milo (customer-facing AI agent), both at DriveClub. Jarvis is the personal complement.

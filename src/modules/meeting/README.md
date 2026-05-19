# MeetingMemory

Ingests Fireflies meeting transcripts via webhook, extracts structured episodes, and writes them to Zep.

## Pipeline

```
Fireflies webhook (transcript ready)
  → fetch full transcript via Fireflies GraphQL API
  → LLM extract: participants, topics, decisions, action items, recruiter signals
  → create Zep episode with participants as entities and topics as relationships
  → action items → Linear issues (via Linear MCP)
  → if meeting is recruiter-related: link to Scout application record
  → push Telegram digest: summary + extracted actions + [confirm/edit] buttons
```

## Why Zep specifically

Personal meetings produce rapidly changing state (job statuses move, relationships evolve, decisions get reversed). Zep's temporal knowledge graph timestamps every fact with a validity window, so when a fact changes the old version is superseded with an end date instead of overwritten. That matches how meetings actually work.

## Status

Not implemented yet.

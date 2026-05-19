# Memory

Jarvis uses a three-layer memory architecture:

1. **Canonical state** in Postgres (Supabase) — source of truth for entities that have a definite shape (applications, people, companies, decisions, tasks, commitments).
2. **Episodic recall** in Zep — temporal knowledge graph for "what happened around X" and "why did we decide Y" queries.
3. **Raw event log** in Postgres — append-only stream of Telegram messages, tool calls, email/calendar deltas, Fireflies transcripts, scheduled job runs. Cheap, auditable.

Each layer answers a different kind of question. The mistake to avoid is putting everything in Zep and treating it as the database. Zep is the reasoning layer beside the system of record, not the system of record itself.

## Why Zep over alternatives (May 2026 landscape)

Researched in May 2026 across Mem0, Zep, Letta, and Cloudflare Agent Memory.

| Framework | Strength | Weakness | Fit for Jarvis |
|---|---|---|---|
| **Mem0** | Largest community (47K stars), easiest integration | Weaker on changing/temporal state | OK for facts, weak for evolving relationships |
| **Zep** | Temporal knowledge graph (Graphiti), fact validity windows, 63.8% on LongMemEval | More setup than Mem0 | **Best fit for layer 2** |
| **Letta** | OS-inspired tiered memory, autonomous self-management | Too much framework gravity for single-user | Overkill |
| **Cloudflare Agent Memory** | Managed, integrates with Cloudflare stack | Still in private beta (April 2026) | Worth watching, not yet |
| **Postgres + pgvector** (DIY) | Full control, no extra vendor | Maintenance burden, no temporal-graph reasoning | Wrong shape alone |

The single biggest failure mode flagged in 2026 personal-assistant literature is **memory staleness on changing facts**. The textbook example: a user changes jobs and the assistant keeps insisting their employer is the old one. Zep solves this directly because every fact has a validity window. When Shaun moves from "interviewing at Vanta" to "in final loop at Vanta" to "rejected by Vanta," each transition supersedes the previous fact with an end date rather than overwriting it.

For Jarvis specifically:
- Job applications change state frequently
- Meeting decisions get revisited and reversed
- Relationships with recruiters evolve over weeks
- People change roles inside their companies

Temporal validity is the right shape for layer 2.

## Memory taxonomy

Following the 2026-standard three-scope model:

1. **Episodic** — Specific events: "Met with Meg Wilson on 2026-05-15 about JD Power Head of AI role"
2. **Semantic** — Facts and preferences: "Shaun targets $400K total comp", "Greg Stewart was direct manager at Indeed"
3. **Procedural** — Learned behaviors: "Use jarvis_remember to capture decisions during meetings"

Zep handles 1 and 2 natively. 3 lives in Supabase config tables that Jarvis loads at startup.

## Schema sketch

### Layer 1: Canonical state (Supabase Postgres)

```
people           (id, name, email, employer, role, source, created_at)
companies        (id, name, domain, type, notes, created_at)
jobs             (id, company_id, title, url, status, comp_band, applied_at, ...)
applications     (id, job_id, resume_used, cover_letter, submitted_at, current_stage)
meetings         (id, fireflies_id, title, started_at, ended_at, participants[], summary)
decisions        (id, subject, decided_at, rationale, related_entities[])
tasks            (id, source, title, due_at, status, owner)
```

### Layer 2: Zep entities and relationships

```
User: "shaun"

Entity types:
  - Person     (recruiters, hiring managers, friends, peers)
  - Company    (employers, prospects, vendors)
  - Job        (specific job applications)
  - Meeting    (Fireflies-ingested meetings)
  - Decision   (committed choices, with rationale)

Edge types (all carry validity windows):
  - APPLIED_TO       (Person → Job)
  - WORKS_AT         (Person → Company)
  - INTERVIEWED      (Person → Job)
  - DECIDED_BY       (Decision → Person)
  - MENTIONED_IN     (Entity → Meeting)
  - REPORTED_TO      (Person → Person)
```

### Layer 3: Raw event log

```
events (
  id          uuid primary key,
  ts          timestamptz not null default now(),
  source      text not null,        -- "telegram", "tool_call", "fireflies_webhook", "gmail", ...
  type        text not null,        -- "message", "tool_response", "transcript_ready", ...
  payload     jsonb not null,
  related     text[]                -- ids of related canonical entities, for joining later
)
```

Indexed by ts and source. Never deleted. Backfills both Zep ingestion and replay-style debugging.

## Access patterns

- `jarvis_remember`: writes to layer 2 (Zep) with optional entity tags. Also appends to layer 3 (event log).
- `jarvis_recall`: queries layer 2 (Zep) by natural language. Augmented with layer 1 (Postgres) facts when entities are known.
- Modules write to layer 1 when state changes (a job moves from "applied" to "phone screen"), and to layer 3 always.
- Layer 2 ingestion happens asynchronously off the event log so Zep failures don't block live operations.

## Cost

Zep Cloud free tier covers initial usage. If we hit the cap, the migration path is to self-host the Zep Docker container on the same Fly VM. Both options are free at our scale; cloud is faster to start.

Supabase free tier (500MB Postgres) is sufficient for layers 1 and 3 indefinitely at single-user scale.

## Codex review (May 2026)

Consulted Codex during initial design. Verdict: Zep is the right call for layer 2, but treating Zep as the whole memory system would be over-engineering. Three-layer architecture (above) is what we adopted.

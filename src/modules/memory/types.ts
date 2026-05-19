/**
 * Types for the Zep ingestion worker.
 *
 * The worker reads from the layer 3 event log (Supabase `events`) and emits
 * structured episodes into Zep (layer 2). An Episode is the unit of memory
 * Zep ingests; we shape one per source event so the event id can be used as
 * an idempotency reference.
 */

export type EpisodeKind = "text" | "json" | "message";

export interface Episode {
  /** Stable reference back to the source event. Used for idempotency. */
  eventId: string;
  /** ISO timestamp of the originating event. */
  occurredAt: string;
  /** Zep graph data type. We mostly use "text" with a human-readable body. */
  kind: EpisodeKind;
  /** Body Zep ingests. For text, a short narrative sentence works best. */
  body: string;
  /** Short description of where this came from, surfaced in Zep UI. */
  sourceDescription: string;
  /** Optional related entity ids (mirrors `events.related`). */
  related?: string[];
}

export interface SourceEvent {
  id: string;
  ts: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  related: string[] | null;
}

export interface IngestionResult {
  startedAt: Date;
  finishedAt: Date;
  eventsRead: number;
  episodesWritten: number;
  skipped: number;
  errors: Array<{ eventId: string; error: string }>;
}

/**
 * Memory module barrel.
 *
 * Public surface: the ingestion entry point and the shared types. The Zep
 * client wrapper stays internal so callers don't reach past the worker.
 */

export { runIngestion } from "./ingestion.js";
export { ensureUser, ZEP_USER_ID } from "./zep-client.js";
export type {
  Episode,
  EpisodeKind,
  IngestionResult,
  SourceEvent,
} from "./types.js";

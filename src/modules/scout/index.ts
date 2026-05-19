/**
 * Scout module public surface.
 * Exposes the operations the custom Jarvis MCP server wraps as tools.
 */

export { runScan, type ScanResult } from "./scanner.js";
export { addBlacklist, getCriteria, getJobById, getWatchlist } from "./db.js";
export {
  listAvailableResumes,
  pickBestResume,
  type ResumeMeta,
  type ResumePick,
  type ResumePickResult,
} from "./resumes.js";
export { scoreJob, isHardSkip } from "./scoring.js";
export type {
  NormalizedJob,
  ScoredJob,
  StoredJob,
  Criteria,
  WatchlistEntry,
  NewMatchEvent,
} from "./types.js";

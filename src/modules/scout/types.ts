/**
 * Scout shared types.
 *
 * Normalized representations of jobs and criteria. Source adapters convert
 * vendor-specific payloads into these types before persistence.
 */

export type Source = "ashby" | "greenhouse" | "lever" | "linkedin" | "workday" | "yc" | "wellfound";

export type ApplicationStage =
  | "submitted"
  | "screen"
  | "interview"
  | "final"
  | "offer"
  | "rejected"
  | "withdrawn";

export type JobStatus = "new" | "matched" | "applied" | "skipped" | "rejected";

/**
 * Normalized job representation. All adapters emit this shape.
 */
export interface NormalizedJob {
  source: Source;
  sourceId: string;
  companyName: string;
  title: string;
  url: string;
  location?: string;
  remote?: boolean;
  compMin?: number;            // USD base
  compMax?: number;            // USD base
  description?: string;
  postedAt?: Date;
}

/**
 * Job as persisted in scout_jobs, with internal fields.
 */
export interface StoredJob extends NormalizedJob {
  id: string;
  companyId?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  score?: number;
  reasons?: ScoringReasons;
  status: JobStatus;
}

/**
 * Hard filter outcome. If any hardSkip is true, the job is skipped entirely.
 */
export interface ScoringReasons {
  hardSkip?: string[];         // ["below_base_floor", "needs_sponsorship", ...]
  positives: string[];         // ["role_keyword_match:vp_engineering", ...]
  negatives: string[];         // ["location_mismatch:nyc_only", ...]
  baseSalaryDelta?: number;    // base_max - base_floor; negative means below floor
}

/**
 * Scored job after running through the scoring pipeline.
 */
export interface ScoredJob extends NormalizedJob {
  score: number;
  reasons: ScoringReasons;
}

/**
 * Shaun's saved hiring criteria. Single row in scout_criteria.
 */
export interface Criteria {
  baseSalaryFloor: number;
  baseSalaryIdeal: number;
  totalCompTarget: number;
  roleKeywordsPositive: string[];
  roleKeywordsNegative: string[];
  domainKeywords: string[];
  locationRequired: "remote_us" | "remote_americas" | "anywhere";
  travelMaxPct: number;
  needsSponsorship: boolean;
}

/**
 * Watchlist entry: a company to scan on a given source.
 */
export interface WatchlistEntry {
  source: Source;
  companySlug: string;
  displayName?: string;
  enabled: boolean;
}

/**
 * Adapter contract. Each source implements this.
 */
export interface SourceAdapter {
  source: Source;
  /**
   * Fetch all current postings for a single company slug.
   * Adapters do NOT dedupe — the scanner handles that.
   */
  fetchCompany(slug: string): Promise<NormalizedJob[]>;
}

/**
 * Event emitted when scanner finds a new high-score job.
 * Notifier consumes these to push to Telegram.
 */
export interface NewMatchEvent {
  jobId: string;
  job: StoredJob;
  pickedResume: string;
}

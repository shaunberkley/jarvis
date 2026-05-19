/**
 * Typed Supabase wrapper for Scout tables.
 *
 * All Scout module code goes through this wrapper rather than touching the
 * raw Supabase client, so the persistence shape stays consistent.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  Criteria,
  NormalizedJob,
  ScoringReasons,
  StoredJob,
  WatchlistEntry,
} from "./types.js";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  client = createClient(url, key, {
    auth: { persistSession: false },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Upsert a normalized job. Returns the stored row and whether it was new.
 * Dedup key: (source, source_id).
 */
export async function upsertJob(
  job: NormalizedJob
): Promise<{ job: StoredJob; isNew: boolean }> {
  const sb = getClient();
  const now = new Date().toISOString();

  // Check if the job already exists.
  const { data: existing, error: selectErr } = await sb
    .from("scout_jobs")
    .select("*")
    .eq("source", job.source)
    .eq("source_id", job.sourceId)
    .maybeSingle();

  if (selectErr) throw selectErr;

  if (existing) {
    // Bump last_seen_at and keep status as-is.
    const { data, error } = await sb
      .from("scout_jobs")
      .update({ last_seen_at: now })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { job: rowToStoredJob(data), isNew: false };
  }

  // Insert new row.
  const { data, error } = await sb
    .from("scout_jobs")
    .insert({
      source: job.source,
      source_id: job.sourceId,
      company_name: job.companyName,
      title: job.title,
      url: job.url,
      location: job.location ?? null,
      remote: job.remote ?? null,
      comp_min: job.compMin ?? null,
      comp_max: job.compMax ?? null,
      description: job.description ?? null,
      posted_at: job.postedAt?.toISOString() ?? null,
      status: "new",
    })
    .select("*")
    .single();
  if (error) throw error;
  return { job: rowToStoredJob(data), isNew: true };
}

/**
 * Look up a single stored job by its primary id. Returns null if no row
 * matches so callers can surface a clean error to the MCP client.
 */
export async function getJobById(jobId: string): Promise<StoredJob | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from("scout_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToStoredJob(data);
}

/**
 * Update a job's score and reasons after scoring.
 */
export async function setJobScore(
  jobId: string,
  score: number,
  reasons: ScoringReasons,
  newStatus: StoredJob["status"]
): Promise<void> {
  const sb = getClient();
  const { error } = await sb
    .from("scout_jobs")
    .update({ score, reasons, status: newStatus })
    .eq("id", jobId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Criteria + watchlist + blacklist
// ---------------------------------------------------------------------------

export async function getCriteria(): Promise<Criteria> {
  const sb = getClient();
  const { data, error } = await sb
    .from("scout_criteria")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return {
    baseSalaryFloor: data.base_salary_floor,
    baseSalaryIdeal: data.base_salary_ideal,
    totalCompTarget: data.total_comp_target,
    roleKeywordsPositive: data.role_keywords_positive ?? [],
    roleKeywordsNegative: data.role_keywords_negative ?? [],
    domainKeywords: data.domain_keywords ?? [],
    locationRequired: data.location_required,
    travelMaxPct: data.travel_max_pct,
    needsSponsorship: data.needs_sponsorship,
  };
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  const sb = getClient();
  const { data, error } = await sb
    .from("scout_watchlist")
    .select("*")
    .eq("enabled", true);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    source: row.source,
    companySlug: row.company_slug,
    displayName: row.display_name ?? undefined,
    enabled: row.enabled,
  }));
}

export async function isBlacklisted(companyName: string): Promise<boolean> {
  const sb = getClient();
  const { data, error } = await sb
    .from("scout_blacklist")
    .select("company_name")
    .eq("company_name", companyName)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function addBlacklist(companyName: string, reason?: string): Promise<void> {
  const sb = getClient();
  const { error } = await sb
    .from("scout_blacklist")
    .upsert({ company_name: companyName, reason: reason ?? null });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

export async function logEvent(
  source: string,
  type: string,
  payload: unknown,
  related?: string[]
): Promise<void> {
  const sb = getClient();
  const { error } = await sb.from("events").insert({
    source,
    type,
    payload,
    related: related ?? null,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function rowToStoredJob(row: Record<string, unknown>): StoredJob {
  return {
    id: row.id as string,
    source: row.source as StoredJob["source"],
    sourceId: row.source_id as string,
    companyId: (row.company_id as string | null) ?? undefined,
    companyName: row.company_name as string,
    title: row.title as string,
    url: row.url as string,
    location: (row.location as string | null) ?? undefined,
    remote: (row.remote as boolean | null) ?? undefined,
    compMin: (row.comp_min as number | null) ?? undefined,
    compMax: (row.comp_max as number | null) ?? undefined,
    description: (row.description as string | null) ?? undefined,
    postedAt: row.posted_at ? new Date(row.posted_at as string) : undefined,
    firstSeenAt: new Date(row.first_seen_at as string),
    lastSeenAt: new Date(row.last_seen_at as string),
    score: (row.score as number | null) ?? undefined,
    reasons: (row.reasons as ScoringReasons | null) ?? undefined,
    status: row.status as StoredJob["status"],
  };
}

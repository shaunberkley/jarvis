/**
 * Scout scoring.
 *
 * Two passes:
 *   1. Hard filters that immediately skip a job (below comp floor, on-site only, sponsorship required, blacklist).
 *   2. Soft scoring (additive) that ranks remaining jobs.
 *
 * Scoring is intentionally simple and deterministic. The LLM layer (Claude
 * Code session reading these jobs in Telegram) does the nuanced reasoning.
 * This pass exists to cut the firehose down to a reviewable list.
 */

import type {
  Criteria,
  NormalizedJob,
  ScoringReasons,
} from "./types.js";

const HARD_FAIL = -1;

/**
 * Score a single job against criteria.
 * Returns a score (0-100, or HARD_FAIL) and reasons.
 */
export function scoreJob(job: NormalizedJob, criteria: Criteria): { score: number; reasons: ScoringReasons } {
  const reasons: ScoringReasons = {
    positives: [],
    negatives: [],
  };

  // -----------------------------------------------------------------------
  // Hard filters
  // -----------------------------------------------------------------------
  const hardSkip: string[] = [];

  // Base comp floor: if compMax is set and below floor, skip
  if (job.compMax != null && job.compMax < criteria.baseSalaryFloor) {
    hardSkip.push(`below_base_floor:${job.compMax}<${criteria.baseSalaryFloor}`);
  }

  // On-site only: if remote === false and location requires remote
  if (job.remote === false && criteria.locationRequired.startsWith("remote")) {
    hardSkip.push(`on_site_only:${job.location ?? "unknown"}`);
  }

  // Sponsorship check: if description mentions "no sponsorship" or similar
  if (!criteria.needsSponsorship && job.description) {
    if (/no\s+(visa\s+)?sponsorship/i.test(job.description)) {
      // Not a skip; some descriptions explicitly say "we don't sponsor" which is FINE for Shaun.
      // Track as positive.
      reasons.positives.push("no_sponsorship_needed_for_us");
    }
    if (/requires?\s+(work|visa)\s+sponsorship/i.test(job.description)) {
      hardSkip.push("sponsorship_required");
    }
  }

  // Negative role keywords are a hard skip if they appear in the title
  const titleLower = job.title.toLowerCase();
  for (const neg of criteria.roleKeywordsNegative) {
    if (titleLower.includes(neg.toLowerCase())) {
      hardSkip.push(`negative_role_keyword:${neg}`);
    }
  }

  if (hardSkip.length > 0) {
    reasons.hardSkip = hardSkip;
    return { score: HARD_FAIL, reasons };
  }

  // -----------------------------------------------------------------------
  // Soft scoring
  // -----------------------------------------------------------------------
  let score = 0;

  // Comp band scoring
  if (job.compMax != null) {
    const delta = job.compMax - criteria.baseSalaryFloor;
    reasons.baseSalaryDelta = delta;
    if (job.compMax >= criteria.baseSalaryIdeal) {
      score += 30;
      reasons.positives.push(`comp_at_or_above_ideal:${job.compMax}>=${criteria.baseSalaryIdeal}`);
    } else if (job.compMax >= criteria.baseSalaryFloor) {
      score += 15;
      reasons.positives.push(`comp_above_floor:${job.compMax}>=${criteria.baseSalaryFloor}`);
    }
  } else {
    // Unknown comp: neutral, slight negative because it implies less standardized comp
    score += 5;
    reasons.positives.push("comp_undisclosed");
  }

  // Positive role keywords in title (heavy weight)
  let titleHits = 0;
  for (const pos of criteria.roleKeywordsPositive) {
    if (titleLower.includes(pos.toLowerCase())) {
      titleHits += 1;
      reasons.positives.push(`title_keyword:${pos}`);
    }
  }
  score += Math.min(titleHits * 15, 45); // cap so spammy keyword stuffing doesn't dominate

  // Domain keywords in title or description
  const haystack = `${job.title} ${job.description ?? ""}`.toLowerCase();
  let domainHits = 0;
  for (const dk of criteria.domainKeywords) {
    if (haystack.includes(dk.toLowerCase())) {
      domainHits += 1;
      reasons.positives.push(`domain_keyword:${dk}`);
    }
  }
  score += Math.min(domainHits * 5, 20);

  // Remote bonus
  if (job.remote === true) {
    score += 5;
    reasons.positives.push("remote");
  }

  return { score: Math.min(score, 100), reasons };
}

export function isHardSkip(score: number): boolean {
  return score === HARD_FAIL;
}

/**
 * Link inbox matches to scout_applications.
 *
 * Heuristic: find the most recent open application whose company name matches
 * one of the inferred companies. If a match exists, suggest a stage transition
 * based on the email classification and surface it for human review.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "../scout/db.js";
import type { Classification, InboxMatch } from "./types.js";
import type { ApplicationStage } from "../scout/types.js";

let sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY required");
  sb = createClient(url, key, { auth: { persistSession: false } });
  return sb;
}

export interface LinkResult {
  matched: number;
  proposedTransitions: Array<{
    applicationId: string;
    company: string;
    currentStage: ApplicationStage;
    proposedStage: ApplicationStage;
    rationale: string;
    inboxEventGmailId: string;
  }>;
}

const stageMap: Partial<Record<Classification, ApplicationStage>> = {
  application_response: "screen",
  interview_scheduling: "interview",
  interview_followup: "interview",
  offer: "offer",
  rejection: "rejected",
};

const stageOrder: Record<ApplicationStage, number> = {
  submitted: 0,
  screen: 1,
  interview: 2,
  final: 3,
  offer: 4,
  rejected: 99,
  withdrawn: 99,
};

export async function linkInboxMatches(matches: InboxMatch[]): Promise<LinkResult> {
  const result: LinkResult = { matched: 0, proposedTransitions: [] };

  for (const match of matches) {
    if (match.inferredCompanies.length === 0) continue;

    for (const company of match.inferredCompanies) {
      const application = await findOpenApplication(company);
      if (!application) continue;
      result.matched += 1;

      const proposed = stageMap[match.classification];
      if (!proposed) continue;
      const currentRank = stageOrder[application.currentStage] ?? 0;
      const proposedRank = stageOrder[proposed];
      // Don't propose backwards transitions (except rejection which is terminal).
      if (proposed !== "rejected" && proposedRank <= currentRank) continue;

      result.proposedTransitions.push({
        applicationId: application.id,
        company,
        currentStage: application.currentStage,
        proposedStage: proposed,
        rationale: `Inbox match (${match.classification}, confidence ${match.confidence.toFixed(2)}): ${match.subject}`,
        inboxEventGmailId: match.gmailId,
      });

      await logEvent(
        "inbox",
        "stage_transition_proposed",
        {
          applicationId: application.id,
          company,
          currentStage: application.currentStage,
          proposedStage: proposed,
          gmailId: match.gmailId,
          subject: match.subject,
        },
        [application.id]
      );
    }
  }

  return result;
}

async function findOpenApplication(
  companyName: string
): Promise<{ id: string; currentStage: ApplicationStage } | null> {
  // Join scout_applications → scout_jobs by job_id to filter by company name.
  // Pick the most recently-updated open application for this company.
  const { data, error } = await db()
    .from("scout_applications")
    .select("id, current_stage, updated_at, job:scout_jobs!inner(company_name)")
    .neq("current_stage", "rejected")
    .neq("current_stage", "withdrawn")
    .eq("scout_jobs.company_name", companyName)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[linker] findOpenApplication error:", error.message);
    return null;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    currentStage: data.current_stage as ApplicationStage,
  };
}

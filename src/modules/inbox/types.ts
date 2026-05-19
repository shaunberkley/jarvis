/**
 * InboxTriage shared types.
 */

export type Classification =
  | "recruiter_outreach"
  | "application_response"
  | "interview_scheduling"
  | "interview_followup"
  | "offer"
  | "rejection"
  | "other";

export interface InboxMatch {
  gmailId: string;
  threadId: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  classification: Classification;
  /** Confidence 0-1 for the classification (heuristic, not LLM). */
  confidence: number;
  /** Companies inferred from sender domain or subject keywords. */
  inferredCompanies: string[];
  /** Score boost reasons. */
  reasons: string[];
}

export interface InboxPollResult {
  startedAt: Date;
  finishedAt: Date;
  messagesScanned: number;
  matches: InboxMatch[];
  errors: string[];
}

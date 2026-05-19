/**
 * Heuristic classifier for inbox messages.
 *
 * Cheap, deterministic regex-based classification. Surfaces matches to the
 * Claude session for nuanced reasoning when needed. The point of this layer
 * is to cut noise, not to be perfect.
 */

import type { Classification } from "./types.js";

interface ClassificationResult {
  classification: Classification;
  confidence: number;
  reasons: string[];
}

interface Signal {
  pattern: RegExp;
  classification: Classification;
  weight: number;
  reason: string;
}

// Order matters somewhat: higher-specificity signals first.
const subjectSignals: Signal[] = [
  // Strong, unambiguous
  { pattern: /\boffer\b/i, classification: "offer", weight: 0.9, reason: "subject:offer" },
  { pattern: /congratulat(ions|ing)/i, classification: "offer", weight: 0.6, reason: "subject:congratulations" },
  { pattern: /unfortunately|not moving forward|decided to move forward with other|regret/i, classification: "rejection", weight: 0.85, reason: "subject:rejection_phrase" },

  // Scheduling / interview
  { pattern: /schedul(e|ing)|availability|book a time|find a time/i, classification: "interview_scheduling", weight: 0.7, reason: "subject:scheduling" },
  { pattern: /interview|onsite|technical screen|phone screen|conversation with|meet (with )?the team/i, classification: "interview_followup", weight: 0.7, reason: "subject:interview" },

  // Application response
  { pattern: /your application|application (for|to|received|status)|next steps/i, classification: "application_response", weight: 0.65, reason: "subject:application_response" },

  // Recruiter outreach
  { pattern: /opportunity at|role at|reaching out|chat about|exciting role|considering you for/i, classification: "recruiter_outreach", weight: 0.55, reason: "subject:recruiter_outreach" },
];

const bodySignals: Signal[] = [
  { pattern: /(extend|happy to extend|extending)\s+(you\s+)?(an?\s+)?offer/i, classification: "offer", weight: 0.95, reason: "body:offer_extended" },
  { pattern: /we (have )?decided not to|will not be moving forward|moved forward with another|won't be moving forward/i, classification: "rejection", weight: 0.9, reason: "body:rejection_decision" },
  { pattern: /book\s+a\s+time|calendly|chili\s*piper|when (are you|works)\s+for/i, classification: "interview_scheduling", weight: 0.6, reason: "body:scheduling_invite" },
  { pattern: /next round|next stage|technical interview|behavioral interview|systems design/i, classification: "interview_followup", weight: 0.55, reason: "body:next_round" },
  { pattern: /(reviewing|review of|reviewed)\s+your\s+application/i, classification: "application_response", weight: 0.5, reason: "body:application_under_review" },
  { pattern: /came across your (profile|background|linkedin)|reaching out (about|because)/i, classification: "recruiter_outreach", weight: 0.5, reason: "body:cold_outreach" },
];

const recruiterDomainHints = [
  /@(.+\.)?gem\.com$/i,
  /@(.+\.)?greenhouse\.io$/i,
  /@(.+\.)?lever\.co$/i,
  /@(.+\.)?ashbyhq\.com$/i,
  /@(.+\.)?workday\.com$/i,
  /@(.+\.)?icims\.com$/i,
  /talent|recruit|talent[._-]?team|talent[._-]?acquisition|hiring/i, // local-part hints
];

export function classifyMessage(args: {
  fromEmail: string;
  subject: string;
  snippet: string;
}): ClassificationResult {
  const { fromEmail, subject, snippet } = args;
  const scores = new Map<Classification, number>();
  const reasons: string[] = [];

  const addScore = (c: Classification, w: number, r: string) => {
    scores.set(c, (scores.get(c) ?? 0) + w);
    reasons.push(r);
  };

  // Subject signals
  for (const sig of subjectSignals) {
    if (sig.pattern.test(subject)) {
      addScore(sig.classification, sig.weight, sig.reason);
    }
  }
  // Body signals
  for (const sig of bodySignals) {
    if (sig.pattern.test(snippet)) {
      addScore(sig.classification, sig.weight, sig.reason);
    }
  }
  // Sender domain hints (modest signal toward recruiter outreach)
  for (const re of recruiterDomainHints) {
    if (re.test(fromEmail)) {
      addScore("recruiter_outreach", 0.25, `sender:${re.source.slice(0, 24)}...`);
      break;
    }
  }

  if (scores.size === 0) {
    return { classification: "other", confidence: 0, reasons: [] };
  }

  let bestClass: Classification = "other";
  let bestScore = 0;
  for (const [c, s] of scores) {
    if (s > bestScore) {
      bestScore = s;
      bestClass = c;
    }
  }

  // Confidence cap and floor.
  const confidence = Math.min(0.95, bestScore);
  return { classification: bestClass, confidence, reasons };
}

/**
 * Infer one or more company names from sender domain or subject text.
 * Used to link emails back to scout_applications.
 */
export function inferCompanies(args: {
  fromEmail: string;
  subject: string;
  candidates: string[]; // candidate company names from scout_applications
}): string[] {
  const { fromEmail, subject, candidates } = args;
  const out = new Set<string>();

  const domain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const subjectLower = subject.toLowerCase();

  for (const c of candidates) {
    const slug = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!slug) continue;
    if (domain.includes(slug)) out.add(c);
    if (subjectLower.includes(c.toLowerCase())) out.add(c);
  }

  return Array.from(out);
}

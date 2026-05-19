/**
 * Scout resume picker.
 *
 * Catalogs every resume variant that lives in /Users/shaunberkley/dev/resume/final
 * and scores each one against a target job using a deterministic heuristic.
 *
 * Why heuristic and not an LLM call: Jarvis runs on the Claude Max
 * subscription, so per-token API calls are explicitly off the table. The
 * picker has to work without any network. When the Claude Code session itself
 * wants LLM-grade matching, it can call the scout_pick_resume MCP tool, read
 * the ranked output, and override at its discretion.
 *
 * Scoring layers (ordered by weight):
 *   1. Exact company match against a tailored variant (very heavy).
 *   2. Fuzzy company match (heavy) for company aliases like "Capital One Bank".
 *   3. Role family match (EM, IC, CTO, Director, AI Leader) inferred from the
 *      job title against the variant's role tags.
 *   4. Domain keyword match (fintech, health, infra, etc.) against the
 *      variant's keyword tags.
 *   5. AI-emphasis boost when the job leans agentic / LLM / ML.
 *   6. Generic main resume as the always-available fallback.
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

export const RESUME_DIR = "/Users/shaunberkley/dev/resume/final";
export const PDF_DIR = join(RESUME_DIR, "pdfs");
export const TAILORED_DIR = join(RESUME_DIR, "tailored");

export type ResumeVariant = "main" | "main-ai" | "role-variant" | "tailored";

export interface ResumeMeta {
  /** Markdown filename relative to RESUME_DIR (or tailored/). */
  markdownFile: string;
  /** PDF filename inside PDF_DIR. Picker returns this for application use. */
  pdfFile: string;
  /** Absolute path to the PDF. */
  pdfPath: string;
  /** Coarse bucket for the variant. */
  variant: ResumeVariant;
  /**
   * Company target for tailored variants (lowercased, hyphen-collapsed).
   * Undefined for generic / role-variant resumes.
   */
  companyTarget?: string;
  /** Role families this variant is good for: em, ic, cto, vp, director, ai-leader. */
  roleTags: string[];
  /** Domain / focus keywords this variant emphasizes. */
  keywords: string[];
  /** True if this variant leans into AI / agentic framing. */
  aiEmphasis: boolean;
}

export interface ResumePick {
  resume: ResumeMeta;
  score: number;
  rationale: string[];
}

export interface ResumePickResult {
  pick: ResumePick;
  alternatives: ResumePick[];
}

// ---------------------------------------------------------------------------
// Static lookup tables
// ---------------------------------------------------------------------------

/**
 * Per-company keyword hints for tailored resumes. The picker still falls back
 * to filename-based matching, so unknown companies still resolve to themselves;
 * this table just adds domain / role context to nudge the ranking.
 */
const COMPANY_HINTS: Record<string, { roleTags?: string[]; keywords?: string[] }> = {
  "1password": { roleTags: ["em", "ic"], keywords: ["security", "identity", "saas", "b2b"] },
  "59pines": { roleTags: ["cto", "vp"], keywords: ["startup", "early-stage"] },
  acorns: { roleTags: ["ic", "em"], keywords: ["fintech", "consumer", "mobile"] },
  affirm: { roleTags: ["ic", "em", "vp"], keywords: ["fintech", "payments", "lending"] },
  airbnb: { roleTags: ["em"], keywords: ["marketplace", "consumer", "web", "mobile"] },
  anthropic: { roleTags: ["ic"], keywords: ["ai", "agent", "llm", "claude"] },
  apollo: { roleTags: ["ic", "em"], keywords: ["graphql", "infra", "developer-tools"] },
  "capital-one": { roleTags: ["em", "vp"], keywords: ["fintech", "banking", "regulated"] },
  chalk: { roleTags: ["ic"], keywords: ["ai", "ml", "infra", "data"] },
  chestnut: { roleTags: ["ic", "em"], keywords: ["fintech", "startup"] },
  circle: { roleTags: ["ic", "em"], keywords: ["fintech", "crypto", "payments"] },
  clickup: { roleTags: ["em", "ic"], keywords: ["productivity", "saas", "b2b"] },
  "cobalt-ai": { roleTags: ["ic", "ai-leader"], keywords: ["ai", "agent", "llm"] },
  coinbase: { roleTags: ["ic", "em"], keywords: ["fintech", "crypto"] },
  commure: { roleTags: ["ic", "em"], keywords: ["healthcare", "ops"] },
  counterpart: { roleTags: ["ic", "em"], keywords: ["fintech", "insurance"] },
  cursor: { roleTags: ["ic"], keywords: ["ai", "developer-tools", "agent"] },
  discord: { roleTags: ["ic", "em"], keywords: ["consumer", "realtime", "web"] },
  gitlab: { roleTags: ["ic", "em"], keywords: ["devops", "remote", "b2b"] },
  headway: { roleTags: ["ic", "em"], keywords: ["healthcare", "marketplace"] },
  helpscout: { roleTags: ["ic", "em"], keywords: ["saas", "support", "b2b"] },
  linear: { roleTags: ["ic"], keywords: ["productivity", "saas", "developer-tools"] },
  mercury: { roleTags: ["vp", "em"], keywords: ["fintech", "banking", "b2b"] },
  mie: { roleTags: ["ic", "em"], keywords: ["healthcare", "enterprise"] },
  netflix: { roleTags: ["ic", "em"], keywords: ["consumer", "streaming", "scale"] },
  onramp: { roleTags: ["ic", "em"], keywords: ["fintech", "crypto"] },
  openai: { roleTags: ["ic", "ai-leader"], keywords: ["ai", "agent", "llm"] },
  perplexity: { roleTags: ["ic", "ai-leader"], keywords: ["ai", "search", "llm"] },
  pinterest: { roleTags: ["em", "ic"], keywords: ["consumer", "discovery", "web"] },
  reddit: { roleTags: ["ic", "em"], keywords: ["consumer", "community", "web"] },
  rula: { roleTags: ["ic", "em"], keywords: ["healthcare", "marketplace"] },
  sailpoint: { roleTags: ["em", "ic"], keywords: ["security", "identity", "enterprise"] },
  "scratch-financial": { roleTags: ["ic", "em"], keywords: ["fintech", "lending"] },
  sierra: { roleTags: ["ic", "ai-leader"], keywords: ["ai", "agent", "voice"] },
  smartsheet: { roleTags: ["em", "vp"], keywords: ["productivity", "saas", "b2b"] },
  vercel: { roleTags: ["ic", "em"], keywords: ["developer-tools", "infra", "web"] },
  webflow: { roleTags: ["em", "ic"], keywords: ["no-code", "web", "designer-tools"] },
};

/**
 * Role-variant resumes that live at the top level of RESUME_DIR.
 * These are role-shaped but not company-tailored.
 */
const ROLE_VARIANTS: Array<{
  markdownFile: string;
  pdfFile: string;
  roleTags: string[];
  keywords: string[];
  aiEmphasis: boolean;
}> = [
  {
    markdownFile: "variant-ai-leader.md",
    pdfFile: "variant-ai-leader.pdf",
    roleTags: ["ai-leader", "vp", "director", "cto"],
    keywords: ["ai", "ml", "agent", "llm", "platform"],
    aiEmphasis: true,
  },
  {
    markdownFile: "variant-cto-vp.md",
    pdfFile: "variant-cto-vp.pdf",
    roleTags: ["cto", "vp"],
    keywords: ["leadership", "platform", "strategy"],
    aiEmphasis: false,
  },
  {
    markdownFile: "variant-director.md",
    pdfFile: "variant-director.pdf",
    roleTags: ["director", "vp"],
    keywords: ["leadership", "org", "platform"],
    aiEmphasis: false,
  },
  {
    markdownFile: "variant-ic.md",
    pdfFile: "variant-ic.pdf",
    roleTags: ["ic", "senior", "staff"],
    keywords: ["ic", "engineering"],
    aiEmphasis: false,
  },
];

// Role-keyword detection for inbound job titles.
const ROLE_TITLE_PATTERNS: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: "cto", patterns: [/\bcto\b/i, /chief\s+technology/i] },
  { tag: "vp", patterns: [/\bvp\b/i, /vice\s+president/i] },
  { tag: "director", patterns: [/\bdirector\b/i, /head\s+of\s+engineering/i] },
  {
    tag: "em",
    patterns: [
      /engineering\s+manager/i,
      /\bem\b/i,
      /\bmanager,?\s+(software|engineering|platform)/i,
    ],
  },
  {
    tag: "ai-leader",
    patterns: [/head\s+of\s+ai/i, /director\s+of\s+ai/i, /vp\s+of\s+ai/i, /ai\s+lead/i],
  },
  {
    tag: "ic",
    patterns: [
      /\b(senior|staff|principal|sr\.?)\s+(engineer|software)/i,
      /\bsoftware\s+engineer\b/i,
      /\bswe\b/i,
    ],
  },
];

// Domain detection from title + description.
const DOMAIN_PATTERNS: Array<{ keyword: string; patterns: RegExp[] }> = [
  { keyword: "ai", patterns: [/\bai\b/i, /artificial\s+intelligence/i] },
  { keyword: "agent", patterns: [/\bagent(ic)?\b/i, /autonomous/i] },
  { keyword: "llm", patterns: [/\bllm\b/i, /large\s+language/i, /foundation\s+model/i] },
  { keyword: "ml", patterns: [/\bml\b/i, /machine\s+learning/i] },
  { keyword: "rag", patterns: [/\brag\b/i, /retrieval[\s-]+augmented/i] },
  { keyword: "fintech", patterns: [/fintech/i, /payments?/i, /banking/i, /lending/i] },
  { keyword: "crypto", patterns: [/crypto/i, /blockchain/i, /web3/i, /defi/i] },
  { keyword: "healthcare", patterns: [/health\s*(care|tech)/i, /clinical/i, /medical/i] },
  { keyword: "security", patterns: [/security/i, /identity/i, /iam\b/i] },
  { keyword: "developer-tools", patterns: [/developer\s+tools?/i, /devtools?/i, /sdk/i] },
  { keyword: "infra", patterns: [/infrastructure/i, /platform\s+engineer/i, /sre\b/i] },
  { keyword: "consumer", patterns: [/consumer/i, /b2c/i] },
  { keyword: "b2b", patterns: [/\bb2b\b/i, /enterprise/i, /saas/i] },
  { keyword: "marketplace", patterns: [/marketplace/i, /two[\s-]+sided/i] },
  { keyword: "remote", patterns: [/remote[\s-]+first/i, /fully\s+remote/i] },
];

const AI_TITLE_HINTS = ["ai", "ml", "agent", "llm", "rag", "generative", "foundation model"];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Read the resume directory and return metadata for every variant that has a
 * matching PDF. Filters out any markdown that lacks a rendered PDF so the
 * caller never points at a stale draft.
 */
export function listAvailableResumes(): ResumeMeta[] {
  const pdfNames = new Set<string>();
  try {
    for (const name of readdirSync(PDF_DIR)) {
      if (name.toLowerCase().endsWith(".pdf")) pdfNames.add(name);
    }
  } catch {
    return [];
  }

  const out: ResumeMeta[] = [];

  // Generic main resumes.
  const mainCandidates: Array<{
    markdownFile: string;
    pdfFile: string;
    variant: ResumeVariant;
    roleTags: string[];
    keywords: string[];
    aiEmphasis: boolean;
  }> = [
    {
      markdownFile: "shaun-berkley-main.md",
      pdfFile: "shaun-berkley-main.pdf",
      variant: "main",
      roleTags: ["vp", "director", "em", "ic"],
      keywords: ["general"],
      aiEmphasis: false,
    },
    {
      markdownFile: "shaun-berkley-main-ai.md",
      pdfFile: "shaun-berkley-main-ai.pdf",
      variant: "main-ai",
      roleTags: ["ic", "em", "vp", "director", "ai-leader"],
      keywords: ["ai", "ml", "agent", "llm"],
      aiEmphasis: true,
    },
  ];

  for (const c of mainCandidates) {
    if (!pdfNames.has(c.pdfFile)) continue;
    out.push({
      markdownFile: c.markdownFile,
      pdfFile: c.pdfFile,
      pdfPath: join(PDF_DIR, c.pdfFile),
      variant: c.variant,
      roleTags: c.roleTags,
      keywords: c.keywords,
      aiEmphasis: c.aiEmphasis,
    });
  }

  // Role variants.
  for (const v of ROLE_VARIANTS) {
    if (!pdfNames.has(v.pdfFile)) continue;
    out.push({
      markdownFile: v.markdownFile,
      pdfFile: v.pdfFile,
      pdfPath: join(PDF_DIR, v.pdfFile),
      variant: "role-variant",
      roleTags: v.roleTags,
      keywords: v.keywords,
      aiEmphasis: v.aiEmphasis,
    });
  }

  // Tailored variants from the tailored/ directory.
  let tailoredFiles: string[] = [];
  try {
    tailoredFiles = readdirSync(TAILORED_DIR);
  } catch {
    tailoredFiles = [];
  }

  for (const file of tailoredFiles) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const slug = basename(file, ".md").toLowerCase();
    const pdfFile = `${slug}.pdf`;
    if (!pdfNames.has(pdfFile)) continue;

    const hint = COMPANY_HINTS[slug];
    out.push({
      markdownFile: `tailored/${file}`,
      pdfFile,
      pdfPath: join(PDF_DIR, pdfFile),
      variant: "tailored",
      companyTarget: slug,
      roleTags: hint?.roleTags ?? ["ic", "em"],
      keywords: hint?.keywords ?? [slug],
      aiEmphasis: (hint?.keywords ?? []).some((k) => ["ai", "agent", "llm", "ml"].includes(k)),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

export interface PickInput {
  jobTitle: string;
  jobDescription?: string;
  companyName: string;
}

/**
 * Score every resume against the job and return the top pick plus ranked
 * alternatives. Pure function: no IO once the catalog is in hand.
 *
 * If availableResumes is omitted, the catalog is read fresh from disk.
 */
export function pickBestResume(
  jobTitle: string,
  jobDescription: string | undefined,
  companyName: string,
  availableResumes?: ResumeMeta[]
): ResumePickResult {
  const catalog = availableResumes ?? listAvailableResumes();
  if (catalog.length === 0) {
    throw new Error("No resumes available in catalog");
  }

  const companySlug = normalizeSlug(companyName);
  const companyTokens = tokenize(companyName);
  const titleLower = jobTitle.toLowerCase();
  const haystack = `${jobTitle} ${jobDescription ?? ""}`.toLowerCase();
  const titleRoleTags = detectRoleTags(jobTitle);
  const matchedDomains = detectDomains(haystack);
  const isAiRole = AI_TITLE_HINTS.some((s) => titleLower.includes(s)) || matchedDomains.has("ai");

  const ranked: ResumePick[] = catalog
    .map((resume) => scoreResume(resume, {
      companySlug,
      companyTokens,
      titleRoleTags,
      matchedDomains,
      isAiRole,
    }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top) {
    throw new Error("No resumes available in catalog");
  }
  return { pick: top, alternatives: ranked.slice(1, 5) };
}

interface ScoringContext {
  companySlug: string;
  companyTokens: string[];
  titleRoleTags: Set<string>;
  matchedDomains: Set<string>;
  isAiRole: boolean;
}

function scoreResume(resume: ResumeMeta, ctx: ScoringContext): ResumePick {
  let score = 0;
  const rationale: string[] = [];

  // 1. Company match (only meaningful for tailored variants).
  if (resume.variant === "tailored" && resume.companyTarget) {
    if (resume.companyTarget === ctx.companySlug) {
      score += 200;
      rationale.push(`exact_company_match:${resume.companyTarget}`);
    } else if (companyTokenOverlap(resume.companyTarget, ctx.companyTokens)) {
      score += 90;
      rationale.push(`fuzzy_company_match:${resume.companyTarget}`);
    } else {
      // A tailored resume aimed at someone else is almost never the right
      // pick. Push it down so it can only win on an extraordinary domain
      // overlap (e.g. another fintech company in the same vertical).
      score -= 60;
      rationale.push(`tailored_for_other_company:${resume.companyTarget}`);
    }
  }

  // 2. Role family match.
  let roleHits = 0;
  for (const tag of resume.roleTags) {
    if (ctx.titleRoleTags.has(tag)) {
      roleHits += 1;
      rationale.push(`role_tag_match:${tag}`);
    }
  }
  score += Math.min(roleHits * 25, 60);

  // 3. Domain keyword match.
  let domainHits = 0;
  for (const kw of resume.keywords) {
    if (ctx.matchedDomains.has(kw)) {
      domainHits += 1;
      rationale.push(`domain_match:${kw}`);
    }
  }
  score += Math.min(domainHits * 10, 40);

  // 4. AI emphasis alignment.
  if (ctx.isAiRole && resume.aiEmphasis) {
    score += 35;
    rationale.push("ai_emphasis_aligned");
  } else if (!ctx.isAiRole && resume.aiEmphasis && resume.variant !== "tailored") {
    score -= 10;
    rationale.push("ai_emphasis_mismatch");
  }

  // 5. Generic floor so something always wins. Main is the universal fallback;
  // main-ai gets the same floor when the job is AI-flavored.
  if (resume.variant === "main") {
    score += 20;
    rationale.push("generic_fallback_available");
  } else if (resume.variant === "main-ai" && ctx.isAiRole) {
    score += 25;
    rationale.push("ai_main_fallback_available");
  }

  return { resume, score, rationale };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectRoleTags(title: string): Set<string> {
  const out = new Set<string>();
  for (const entry of ROLE_TITLE_PATTERNS) {
    if (entry.patterns.some((p) => p.test(title))) out.add(entry.tag);
  }
  return out;
}

function detectDomains(haystack: string): Set<string> {
  const out = new Set<string>();
  for (const entry of DOMAIN_PATTERNS) {
    if (entry.patterns.some((p) => p.test(haystack))) out.add(entry.keyword);
  }
  return out;
}

function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,.'’]/g, "")
    .replace(/\s*(inc|llc|ltd|corp|co|corporation|company)\s*$/i, "")
    .trim()
    .replace(/\s+/g, "-");
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[,.'’]/g, "")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !COMPANY_STOPWORDS.has(t));
}

const COMPANY_STOPWORDS = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "co",
  "corporation",
  "company",
  "the",
  "and",
  "of",
]);

function companyTokenOverlap(slug: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const slugTokens = slug.split("-").filter((t) => t.length > 1);
  for (const t of tokens) {
    if (slugTokens.includes(t)) return true;
  }
  return false;
}

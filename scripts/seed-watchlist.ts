/**
 * Seed scout_watchlist with companies Shaun cares about, and set initial
 * scout_criteria to match the framework saved in memory.
 *
 * Idempotent: re-running is safe. Existing rows are upserted, not duplicated.
 *
 * Usage:
 *   bun run scripts/seed-watchlist.ts
 */

import { createClient } from "@supabase/supabase-js";

interface WatchlistSeed {
  source: "ashby" | "greenhouse" | "lever";
  companySlug: string;
  displayName: string;
}

// Companies known to use specific ATS systems (manually curated).
// Add to this list as Jarvis discovers new ones worth tracking.
const watchlist: WatchlistSeed[] = [
  // Ashby
  { source: "ashby", companySlug: "vanta", displayName: "Vanta" },
  { source: "ashby", companySlug: "1password", displayName: "1Password" },
  { source: "ashby", companySlug: "ashby", displayName: "Ashby" },
  { source: "ashby", companySlug: "linear", displayName: "Linear" },
  { source: "ashby", companySlug: "glean", displayName: "Glean" },
  { source: "ashby", companySlug: "openai", displayName: "OpenAI" },

  // Greenhouse
  { source: "greenhouse", companySlug: "anthropic", displayName: "Anthropic" },
  { source: "greenhouse", companySlug: "stripe", displayName: "Stripe" },
  { source: "greenhouse", companySlug: "figmainc", displayName: "Figma" },
  { source: "greenhouse", companySlug: "notion", displayName: "Notion" },
  { source: "greenhouse", companySlug: "veeva", displayName: "Veeva" },
  { source: "greenhouse", companySlug: "zapier", displayName: "Zapier" },
  { source: "greenhouse", companySlug: "webflow", displayName: "Webflow" },
  { source: "greenhouse", companySlug: "ycombinator", displayName: "Y Combinator" },

  // Lever
  { source: "lever", companySlug: "counterpart", displayName: "Counterpart" },
  { source: "lever", companySlug: "aleph", displayName: "Aleph" },
];

const criteria = {
  base_salary_floor: 240000,
  base_salary_ideal: 250000,
  total_comp_target: 400000,
  role_keywords_positive: [
    "vp engineering",
    "head of engineering",
    "head of ai",
    "director of engineering",
    "engineering manager",
    "senior engineering manager",
    "founding",
    "growth",
    "monetization",
    "billing",
    "platform",
    "ai enablement",
    "forward deployed",
    "tech lead",
    "staff engineer",
    "principal engineer",
  ],
  role_keywords_negative: [
    "intern",
    "junior",
    "associate",
    "manager of managers", // misnomer often used for VP-of-VP, skip
    "salesforce admin",
    "data analyst",
    "infrastructure director",
    "vp infrastructure",
  ],
  domain_keywords: [
    "ai",
    "agent",
    "llm",
    "rag",
    "platform ui",
    "growth",
    "monetization",
    "billing",
    "pricing",
    "developer tools",
    "developer experience",
    "regulated",
    "fintech",
    "healthcare",
    "compliance",
    "soc 2",
    "hipaa",
    "pci",
  ],
  location_required: "remote_us",
  travel_max_pct: 25,
  needs_sponsorship: false,
};

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Criteria (singleton row, id=1)
  const { error: critErr } = await sb
    .from("scout_criteria")
    .upsert({ id: 1, ...criteria, updated_at: new Date().toISOString() });
  if (critErr) throw critErr;
  console.log("[seed] criteria upserted");

  // Watchlist
  const rows = watchlist.map((w) => ({
    source: w.source,
    company_slug: w.companySlug,
    display_name: w.displayName,
    enabled: true,
  }));
  const { error: wlErr } = await sb
    .from("scout_watchlist")
    .upsert(rows, { onConflict: "source,company_slug" });
  if (wlErr) throw wlErr;
  console.log(`[seed] watchlist upserted: ${rows.length} entries`);

  console.log("[seed] done");
}

void main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});

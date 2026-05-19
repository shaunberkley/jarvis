/**
 * Ashby source adapter.
 *
 * Uses the public Ashby posting API:
 *   GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *
 * No auth required. Returns all currently-listed jobs for the company.
 */

import type { NormalizedJob, SourceAdapter } from "../types.js";

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  applicationFormUrl?: string;
  team?: string;
  department?: string;
  locationName?: string;
  isRemote?: boolean;
  publishedAt?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    compensationTiers?: Array<{
      tierSummary?: string;
      components?: Array<{
        compensationType?: string;
        compType?: string;
        interval?: string;
        currencyCode?: string;
        minValue?: number | string;
        maxValue?: number | string;
      }>;
    }>;
  };
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

export const ashbyAdapter: SourceAdapter = {
  source: "ashby",

  async fetchCompany(slug: string): Promise<NormalizedJob[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Ashby fetch failed for ${slug}: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as AshbyResponse;
    const jobs = data.jobs ?? [];
    return jobs.map((j) => normalize(slug, j));
  },
};

function normalize(slug: string, j: AshbyJob): NormalizedJob {
  const { compMin, compMax } = extractComp(j);
  return {
    source: "ashby",
    sourceId: j.id,
    companyName: prettifySlug(slug),
    title: j.title,
    url: j.jobUrl ?? j.applicationFormUrl ?? `https://jobs.ashbyhq.com/${slug}/${j.id}`,
    location: j.locationName ?? undefined,
    remote: j.isRemote ?? undefined,
    compMin,
    compMax,
    description: j.descriptionPlain ?? stripHtml(j.descriptionHtml) ?? undefined,
    postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
  };
}

function extractComp(j: AshbyJob): { compMin?: number; compMax?: number } {
  const tier = j.compensation?.compensationTiers?.[0];
  if (!tier) return {};
  const base = tier.components?.find(
    (c) => (c.compType ?? c.compensationType ?? "").toLowerCase().includes("salary")
  );
  if (!base) return {};
  if (base.currencyCode && base.currencyCode !== "USD") return {};
  const min = toNumber(base.minValue);
  const max = toNumber(base.maxValue);
  return { compMin: min, compMax: max };
}

function toNumber(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

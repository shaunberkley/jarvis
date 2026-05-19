/**
 * Lever source adapter.
 *
 * Uses the public Lever postings API:
 *   GET https://api.lever.co/v0/postings/{slug}?mode=json
 *
 * No auth required. Returns all currently-published postings.
 */

import type { NormalizedJob, SourceAdapter } from "../types.js";

interface LeverPosting {
  id: string;
  text: string;                                  // job title
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;                            // unix ms
  categories?: {
    location?: string;
    team?: string;
    department?: string;
    commitment?: string;
  };
  descriptionPlain?: string;
  description?: string;                          // html
  workplaceType?: "remote" | "on-site" | "hybrid" | "unspecified";
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;                           // "per-year-salary" etc.
  };
}

export const leverAdapter: SourceAdapter = {
  source: "lever",

  async fetchCompany(slug: string): Promise<NormalizedJob[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Lever fetch failed for ${slug}: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as LeverPosting[];
    return (data ?? []).map((j) => normalize(slug, j));
  },
};

function normalize(slug: string, j: LeverPosting): NormalizedJob {
  const { compMin, compMax } = extractComp(j);
  return {
    source: "lever",
    sourceId: j.id,
    companyName: prettifySlug(slug),
    title: j.text,
    url: j.hostedUrl ?? j.applyUrl ?? "",
    location: j.categories?.location ?? undefined,
    remote: j.workplaceType === "remote" ? true : j.workplaceType === "on-site" ? false : undefined,
    compMin,
    compMax,
    description: j.descriptionPlain ?? stripHtml(j.description) ?? undefined,
    postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
  };
}

function extractComp(j: LeverPosting): { compMin?: number; compMax?: number } {
  const range = j.salaryRange;
  if (!range) return {};
  if (range.currency && range.currency !== "USD") return {};
  // Lever's interval should be a salary one. Skip hourly/weekly to avoid scale confusion.
  if (range.interval && !range.interval.toLowerCase().includes("year")) return {};
  return {
    compMin: range.min != null ? Math.round(range.min) : undefined,
    compMax: range.max != null ? Math.round(range.max) : undefined,
  };
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

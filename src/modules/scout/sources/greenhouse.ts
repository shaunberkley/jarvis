/**
 * Greenhouse source adapter.
 *
 * Uses the public job board API:
 *   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 *
 * No auth required for public job boards. Returns all currently-listed jobs.
 */

import type { NormalizedJob, SourceAdapter } from "../types.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  content?: string;
  metadata?: Array<{
    id?: number;
    name?: string;
    value?: string | number | null;
  }>;
  pay_input_ranges?: Array<{
    label?: string;
    min_cents?: number;
    max_cents?: number;
    currency_type?: string;
  }>;
  offices?: Array<{ name?: string }>;
  departments?: Array<{ name?: string }>;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export const greenhouseAdapter: SourceAdapter = {
  source: "greenhouse",

  async fetchCompany(slug: string): Promise<NormalizedJob[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Greenhouse fetch failed for ${slug}: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GreenhouseResponse;
    return (data.jobs ?? []).map((j) => normalize(slug, j));
  },
};

function normalize(slug: string, j: GreenhouseJob): NormalizedJob {
  const { compMin, compMax } = extractComp(j);
  const location = j.location?.name ?? j.offices?.[0]?.name;
  return {
    source: "greenhouse",
    sourceId: String(j.id),
    companyName: prettifySlug(slug),
    title: j.title,
    url: j.absolute_url,
    location: location ?? undefined,
    remote: isRemote(location),
    compMin,
    compMax,
    description: stripHtml(j.content),
    postedAt: j.first_published ? new Date(j.first_published) : j.updated_at ? new Date(j.updated_at) : undefined,
  };
}

function extractComp(j: GreenhouseJob): { compMin?: number; compMax?: number } {
  const range = j.pay_input_ranges?.[0];
  if (!range) return {};
  if (range.currency_type && range.currency_type !== "USD") return {};
  const min = range.min_cents != null ? Math.round(range.min_cents / 100) : undefined;
  const max = range.max_cents != null ? Math.round(range.max_cents / 100) : undefined;
  return { compMin: min, compMax: max };
}

function isRemote(location: string | undefined): boolean | undefined {
  if (!location) return undefined;
  return /remote/i.test(location);
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

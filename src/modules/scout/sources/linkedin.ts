/**
 * LinkedIn source adapter.
 *
 * IMPORTANT OPERATOR NOTES
 * ------------------------
 * 1. Login is NOT automated. LinkedIn aggressively detects and challenges
 *    automated logins (captcha, email verification, phone verification,
 *    account restriction). Instead, this adapter relies on a Browserbase
 *    persistent context that already has a valid logged-in session.
 *
 *    One-time setup flow:
 *      a. Create a Browserbase project and grab BROWSERBASE_API_KEY +
 *         BROWSERBASE_PROJECT_ID.
 *      b. Create a persistent context via the Browserbase dashboard or API.
 *      c. Start a live session bound to that context, open it in your
 *         browser, navigate to https://www.linkedin.com/login, log in
 *         manually, satisfy any 2FA, and confirm the feed loads.
 *      d. End the session. The cookies persist on the context.
 *      e. Set LINKEDIN_CONTEXT_ID to the context id. The scanner will
 *         reuse it on every run.
 *
 *    If the session ever gets logged out (LinkedIn rotates cookies, or
 *    triggers a security check), repeat steps c through d.
 *
 * 2. Scan cadence is intentionally conservative. The default time window
 *    is r3600 (posted in the last hour) so an hourly cron only ever
 *    requests a small slice of fresh postings. This keeps request volume
 *    low and pattern-of-use closer to a human checking jobs once an hour.
 *    Tune via SCOUT_LINKEDIN_TPR (e.g. r86400 for the last day) only if
 *    you understand the detection trade-off.
 *
 * 3. TOS / legal risk: LinkedIn's User Agreement prohibits automated
 *    access and scraping of the site. The hiQ v. LinkedIn line of cases
 *    addresses public data scraping, but does NOT bless logged-in
 *    scraping, and LinkedIn can (and does) ban accounts they detect
 *    doing it. This adapter is provided for personal use against your
 *    own account. You accept the risk of account restriction or ban.
 *    If that risk is unacceptable, do not enable this source.
 *
 * SLUG SEMANTICS
 * --------------
 * Unlike the company-board adapters (ashby, greenhouse, lever), the
 * `slug` argument here is interpreted as a search QUERY, since the
 * LinkedIn watchlist holds queries like "engineering manager remote"
 * rather than per-company slugs.
 */

import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import type { NormalizedJob, SourceAdapter } from "../types.js";

const DEFAULT_TPR = "r3600"; // posted in the last hour
const SEARCH_URL = "https://www.linkedin.com/jobs/search/";
const NAV_TIMEOUT_MS = 45_000;
const RESULTS_WAIT_MS = 15_000;

export const linkedinAdapter: SourceAdapter = {
  source: "linkedin",

  async fetchCompany(slug: string): Promise<NormalizedJob[]> {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    const contextId = process.env.LINKEDIN_CONTEXT_ID;
    const tpr = process.env.SCOUT_LINKEDIN_TPR || DEFAULT_TPR;

    if (!apiKey || !projectId) {
      throw new Error(
        "LinkedIn adapter requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID."
      );
    }
    if (!contextId) {
      throw new Error(
        "LinkedIn adapter requires LINKEDIN_CONTEXT_ID. One-time setup: create a Browserbase persistent context, open a live session bound to it, log into linkedin.com manually, then set LINKEDIN_CONTEXT_ID to that context id."
      );
    }

    const query = slug.trim();
    if (!query) return [];

    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId,
      browserSettings: {
        context: {
          id: contextId,
          persist: true,
        },
      },
    });

    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());

      const searchUrl = buildSearchUrl(query, tpr);
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      // Wait for any of the known results containers. Defensive: LinkedIn
      // serves at least two layouts (logged-in app shell vs guest shell).
      await waitForResults(page);
      await autoScroll(page);

      const cards = await extractJobCards(page);
      return cards.map((c) => normalize(query, c)).filter(Boolean) as NormalizedJob[];
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore close errors
        }
      }
      // Best-effort release of the Browserbase session.
      try {
        await bb.sessions.update(session.id, {
          projectId,
          status: "REQUEST_RELEASE",
        });
      } catch {
        // ignore release errors
      }
    }
  },
};

function buildSearchUrl(query: string, tpr: string): string {
  const params = new URLSearchParams({
    keywords: query,
    f_TPR: tpr,
    sortBy: "DD", // sort by date posted, descending
  });
  return `${SEARCH_URL}?${params.toString()}`;
}

async function waitForResults(page: Page): Promise<void> {
  const selectors = [
    "div.jobs-search-results-list",
    "ul.jobs-search__results-list",
    "div.scaffold-layout__list",
    "main[aria-label='Search results']",
    "div.jobs-search-results",
  ];
  const start = Date.now();
  while (Date.now() - start < RESULTS_WAIT_MS) {
    for (const sel of selectors) {
      const handle = await page.$(sel);
      if (handle) return;
    }
    await page.waitForTimeout(500);
  }
  // Don't throw. The page may still contain cards in an unexpected wrapper.
  // The extractor will simply return [] if nothing matches.
}

async function autoScroll(page: Page): Promise<void> {
  // Trigger LinkedIn's lazy load. Bounded so we don't sit forever.
  try {
    await page.evaluate(async () => {
      const g = globalThis as any;
      const doc = g.document;
      const win = g.window;
      const containers = [
        doc?.querySelector("div.jobs-search-results-list"),
        doc?.querySelector("ul.jobs-search__results-list"),
        doc?.querySelector("div.scaffold-layout__list"),
        doc?.scrollingElement,
      ].filter(Boolean);
      const target = containers[0];
      if (!target) return;
      for (let i = 0; i < 6; i++) {
        target.scrollBy?.(0, 800);
        win?.scrollBy?.(0, 800);
        await new Promise((r) => setTimeout(r, 400));
      }
    });
  } catch {
    // ignore scroll errors
  }
}

interface RawCard {
  title?: string;
  company?: string;
  location?: string;
  href?: string;
  postedIso?: string;
  postedText?: string;
  salaryText?: string;
}

async function extractJobCards(page: Page): Promise<RawCard[]> {
  const result = await page.evaluate(() => {
    const g = globalThis as any;
    const doc = g.document;
    if (!doc) return [];

    const cardSelectors = [
      "li.jobs-search-results__list-item",
      "div.job-search-card",
      "li.scaffold-layout__list-item",
      "div.jobs-search-results-list__list-item",
      "li.ember-view.jobs-search-results__list-item",
    ];
    let nodes: any[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel)) as any[];
      if (found.length > 0) {
        nodes = found;
        break;
      }
    }
    if (nodes.length === 0) {
      const anchors = Array.from(doc.querySelectorAll("a[href*='/jobs/view/']")) as any[];
      const seen = new Set<any>();
      for (const a of anchors) {
        const li = a.closest("li,article,div");
        if (li && !seen.has(li)) {
          seen.add(li);
          nodes.push(li);
        }
      }
    }

    const text = (el: any): string => {
      if (!el) return "";
      return (el.textContent || "").replace(/\s+/g, " ").trim();
    };

    const pickAttr = (el: any, attrs: string[]): string | undefined => {
      if (!el) return undefined;
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v) return v;
      }
      return undefined;
    };

    return nodes.map((node: any) => {
      const titleEl =
        node.querySelector(".job-card-list__title") ||
        node.querySelector(".base-search-card__title") ||
        node.querySelector("h3.base-search-card__title") ||
        node.querySelector("a.job-card-list__title") ||
        node.querySelector("a[data-control-name='job_search_job_title']") ||
        node.querySelector("a[href*='/jobs/view/']");

      const companyEl =
        node.querySelector(".job-card-container__primary-description") ||
        node.querySelector(".job-card-container__company-name") ||
        node.querySelector(".base-search-card__subtitle") ||
        node.querySelector("h4.base-search-card__subtitle") ||
        node.querySelector("a.job-card-container__company-name");

      const locationEl =
        node.querySelector(".job-card-container__metadata-item") ||
        node.querySelector(".job-search-card__location") ||
        node.querySelector(".artdeco-entity-lockup__caption");

      const timeEl =
        node.querySelector("time") ||
        node.querySelector(".job-search-card__listdate") ||
        node.querySelector(".job-search-card__listdate--new");

      const salaryEl =
        node.querySelector(".job-search-card__salary-info") ||
        node.querySelector(".job-card-container__metadata-wrapper [class*='salary']") ||
        node.querySelector("[class*='salary-info']");

      const anchor =
        node.querySelector("a.job-card-list__title") ||
        node.querySelector("a.base-card__full-link") ||
        node.querySelector("a[href*='/jobs/view/']");

      return {
        title: text(titleEl),
        company: text(companyEl),
        location: text(locationEl),
        href: anchor?.href,
        postedIso: pickAttr(timeEl, ["datetime"]),
        postedText: text(timeEl),
        salaryText: text(salaryEl),
      };
    });
  });
  return result as RawCard[];
}

function normalize(query: string, c: RawCard): NormalizedJob | null {
  const url = canonicalize(c.href);
  const id = extractJobId(url ?? c.href);
  if (!id || !url || !c.title || !c.company) {
    return null;
  }
  const { compMin, compMax } = parseSalary(c.salaryText);
  const remote = inferRemote(c.location, c.title, query);
  return {
    source: "linkedin",
    sourceId: id,
    companyName: c.company,
    title: c.title,
    url,
    location: c.location || undefined,
    remote,
    compMin,
    compMax,
    postedAt: parsePosted(c.postedIso, c.postedText),
  };
}

function canonicalize(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const id = extractJobId(href);
  if (!id) return href.split("?")[0];
  return `https://www.linkedin.com/jobs/view/${id}/`;
}

function extractJobId(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const view = href.match(/\/jobs\/view\/(\d+)/);
  if (view) return view[1];
  const currentJobId = href.match(/[?&]currentJobId=(\d+)/);
  if (currentJobId) return currentJobId[1];
  const trailing = href.match(/-(\d{6,})\b/);
  if (trailing) return trailing[1];
  return undefined;
}

function parsePosted(iso: string | undefined, fallback: string | undefined): Date | undefined {
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (fallback) {
    const rel = parseRelative(fallback);
    if (rel) return rel;
  }
  return undefined;
}

function parseRelative(text: string): Date | undefined {
  const m = text.toLowerCase().match(/(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s*ago/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  if (!unit) return undefined;
  const now = Date.now();
  const ms =
    unit.startsWith("min") ? n * 60_000 :
    unit.startsWith("hour") || unit.startsWith("hr") ? n * 3_600_000 :
    unit.startsWith("day") ? n * 86_400_000 :
    unit.startsWith("week") ? n * 7 * 86_400_000 :
    unit.startsWith("month") ? n * 30 * 86_400_000 :
    0;
  if (!ms) return undefined;
  return new Date(now - ms);
}

function parseSalary(text: string | undefined): { compMin?: number; compMax?: number } {
  if (!text) return {};
  const t = text.replace(/,/g, "");
  // LinkedIn renders salary as e.g. "$180K/yr - $220K/yr" or "$180,000.00/yr - $220,000.00/yr"
  // Only treat as annual base if /yr is present and currency is USD ($).
  const isUsd = /\$/.test(text);
  const isAnnual = /\/(yr|year)/i.test(text) || !/(\/hr|\/mo|\/month|\/wk|\/week)/i.test(text);
  if (!isUsd || !isAnnual) return {};
  const nums = Array.from(t.matchAll(/\$\s*(\d+(?:\.\d+)?)(k|m)?/gi)).map((m) => {
    const base = Number(m[1]);
    const suffix = (m[2] || "").toLowerCase();
    if (!Number.isFinite(base)) return NaN;
    if (suffix === "k") return base * 1_000;
    if (suffix === "m") return base * 1_000_000;
    return base;
  }).filter((n) => Number.isFinite(n)) as number[];
  if (nums.length === 0) return {};
  const min = Math.round(Math.min(...nums));
  const max = Math.round(Math.max(...nums));
  return { compMin: min, compMax: max === min ? undefined : max };
}

function inferRemote(
  location: string | undefined,
  title: string | undefined,
  query: string | undefined
): boolean | undefined {
  const haystack = `${location ?? ""} ${title ?? ""} ${query ?? ""}`.toLowerCase();
  if (/\bremote\b/.test(haystack)) return true;
  if (/\bon[\s-]?site\b/.test(haystack)) return false;
  return undefined;
}

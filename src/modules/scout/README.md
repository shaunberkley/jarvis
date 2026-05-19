# Scout

Job hunting module. Scans LinkedIn and ATS APIs hourly for fresh postings, ranks against Shaun's saved criteria, and surfaces matches in Telegram with thumbs-up/down review.

## Sources (ranked by value)

1. **LinkedIn** with `f_TPR=r3600` (last hour) — persistent logged-in session via Browserbase
2. **Ashby / Greenhouse / Lever** public job board APIs — watchlist of target companies
3. **Y Combinator Work at a Startup** — feed
4. **Wellfound** (formerly AngelList)
5. **Workday** — per-company watchlist, harder

## Pipeline

```
hourly cron
  → scan sources
  → dedupe against Supabase applied/seen table
  → score against criteria (role types, comp band, domain fits)
  → for matches: pick best-fit resume from tailored/, optionally generate new variant
  → if auto-apply enabled for ATS: fill form via Browserbase
  → push to Telegram with: title, company, comp, fit summary, resume used, [👍] [👎] buttons
  → Shaun confirms → final submit, OR rejects → log reason, blacklist if needed
```

## State

Lives in Supabase tables:
- `scout_jobs` (jobs seen)
- `scout_applications` (jobs applied to)
- `scout_recruiters` (recruiter contacts and replies)
- `scout_criteria` (Shaun's saved preferences)

## Status

Not implemented yet.

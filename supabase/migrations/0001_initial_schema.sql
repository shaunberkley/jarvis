-- Jarvis initial schema.
-- Three-layer memory: canonical state + event log. Zep handles layer 2.

set search_path to public;

-- ---------------------------------------------------------------------------
-- Layer 3: append-only event log
-- ---------------------------------------------------------------------------

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  source      text not null,
  type        text not null,
  payload     jsonb not null,
  related     text[]
);

create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_source_idx on events (source);
create index if not exists events_type_idx on events (type);

-- ---------------------------------------------------------------------------
-- Layer 1: canonical state — Scout (job hunting) module
-- ---------------------------------------------------------------------------

create table if not exists companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  domain      text,
  type        text,                          -- "prospect", "applied", "employer", "vendor"
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text,
  company_id  uuid references companies (id),
  role        text,
  source      text,                          -- where Jarvis learned about this person
  created_at  timestamptz not null default now()
);

create index if not exists people_email_idx on people (email);
create index if not exists people_company_idx on people (company_id);

create table if not exists scout_jobs (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,             -- "ashby", "greenhouse", "lever", "linkedin", ...
  source_id       text not null,             -- vendor-specific job id
  company_id      uuid references companies (id),
  company_name    text not null,             -- denormalized for fast filter
  title           text not null,
  url             text not null,
  location        text,
  remote          boolean,
  comp_min        integer,                   -- USD base, nullable
  comp_max        integer,                   -- USD base, nullable
  description     text,
  posted_at       timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  score           integer,                   -- nullable until scored
  reasons         jsonb,                     -- scoring rationale
  status          text not null default 'new',  -- "new", "matched", "applied", "skipped", "rejected"
  unique (source, source_id)
);

create index if not exists scout_jobs_status_idx on scout_jobs (status);
create index if not exists scout_jobs_score_idx on scout_jobs (score desc nulls last);
create index if not exists scout_jobs_first_seen_idx on scout_jobs (first_seen_at desc);
create index if not exists scout_jobs_company_idx on scout_jobs (company_id);

create table if not exists scout_applications (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references scout_jobs (id) on delete cascade,
  resume_used     text not null,             -- filename or variant id
  cover_letter    text,
  custom_answers  jsonb,                     -- map of question → answer
  submitted_at    timestamptz,
  submitted_by    text,                      -- "jarvis_auto" or "shaun_manual"
  current_stage   text not null default 'submitted', -- "submitted", "screen", "interview", "offer", "rejected", "withdrawn"
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists scout_applications_job_idx on scout_applications (job_id);
create index if not exists scout_applications_stage_idx on scout_applications (current_stage);

create table if not exists scout_recruiters (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references people (id),
  job_id          uuid references scout_jobs (id),
  application_id  uuid references scout_applications (id),
  last_contact_at timestamptz,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists scout_recruiters_person_idx on scout_recruiters (person_id);
create index if not exists scout_recruiters_application_idx on scout_recruiters (application_id);

create table if not exists scout_criteria (
  id              integer primary key default 1 check (id = 1),  -- singleton row
  base_salary_floor       integer not null default 240000,
  base_salary_ideal       integer not null default 250000,
  total_comp_target       integer not null default 400000,
  role_keywords_positive  text[] not null default '{}',
  role_keywords_negative  text[] not null default '{}',
  domain_keywords         text[] not null default '{}',
  location_required       text not null default 'remote_us',
  travel_max_pct          integer not null default 25,
  needs_sponsorship       boolean not null default false,
  updated_at              timestamptz not null default now()
);

-- Singleton row, criteria evolve over time
insert into scout_criteria (id) values (1)
on conflict do nothing;

create table if not exists scout_blacklist (
  company_name    text primary key,
  reason          text,
  blacklisted_at  timestamptz not null default now()
);

create table if not exists scout_watchlist (
  source          text not null,             -- "ashby", "greenhouse", "lever"
  company_slug    text not null,             -- vendor-specific slug used in API URL
  display_name    text,
  enabled         boolean not null default true,
  added_at        timestamptz not null default now(),
  primary key (source, company_slug)
);

-- ---------------------------------------------------------------------------
-- Layer 1: canonical state — Meetings, Decisions, Tasks (Jarvis core)
-- ---------------------------------------------------------------------------

create table if not exists meetings (
  id              uuid primary key default gen_random_uuid(),
  fireflies_id    text unique,
  title           text not null,
  started_at      timestamptz,
  ended_at        timestamptz,
  participants    text[],
  summary         text,
  transcript_url  text,
  related_job_id  uuid references scout_jobs (id),
  created_at      timestamptz not null default now()
);

create index if not exists meetings_started_idx on meetings (started_at desc);

create table if not exists decisions (
  id              uuid primary key default gen_random_uuid(),
  subject         text not null,
  decided_at      timestamptz not null default now(),
  rationale       text,
  related_entities text[],
  source_meeting  uuid references meetings (id),
  created_at      timestamptz not null default now()
);

create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,             -- "meeting", "telegram", "scout", "manual"
  source_ref      text,                      -- reference to source entity
  title           text not null,
  description     text,
  due_at          timestamptz,
  status          text not null default 'open',  -- "open", "in_progress", "done", "cancelled"
  owner           text not null default 'shaun',
  linear_issue_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tasks_status_idx on tasks (status);
create index if not exists tasks_due_idx on tasks (due_at);

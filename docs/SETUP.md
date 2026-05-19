# Jarvis Setup

## Overview

This runbook takes a fresh git clone to a working deployed Jarvis on Fly.io in under 30 minutes, assuming third-party accounts (Telegram, Supabase, Zep, Browserbase, etc.) can be created in parallel while you work through the early steps. Jarvis runs as a long-lived Claude Code session inside a personal Fly.io VM, controlled from Shaun's phone via Telegram, with canonical state in Supabase and episodic memory in Zep.

For the why behind any of this, read [`README.md`](../README.md) and [`docs/architecture.md`](architecture.md) first. Memory layering is explained in [`docs/memory.md`](memory.md). This document is purely operational.

## Prerequisites

CLI tools (install once, globally):

```bash
brew install flyctl
brew install supabase/tap/supabase
curl -fsSL https://bun.sh/install | bash
brew install jq
```

Accounts needed (create these in parallel; sign-up links given in the relevant steps below):

- Fly.io (personal account, separate from any DriveClub org)
- Supabase (personal project)
- Telegram (account on your phone)
- Google Cloud (for Gmail and Calendar OAuth clients)
- Fireflies.ai (for meeting transcripts)
- Zep Cloud
- Linear (personal workspace or use existing)
- Browserbase
- Access to Bob's Fly app (to copy the Claude OAuth token)

Authenticate the CLIs:

```bash
fly auth login
supabase login
```

## Step 1. Clone the repo and install dependencies

```bash
git clone https://github.com/shaunberkley/jarvis.git
cd jarvis
bun install
cp .env.example .env
```

Leave `.env` empty for now. You will fill it in as you collect each secret. The same values get pushed to Fly in Step 12.

## Step 2. Create the personal Fly app and volume

The app name in `fly.toml` is `jarvis-shaun`, in the `lax` region, with a 1GB persistent volume mounted at `/data`.

```bash
fly apps create jarvis-shaun --org personal
fly volumes create jarvis_data --region lax --size 3 --app jarvis-shaun
```

Confirm:

```bash
fly volumes list --app jarvis-shaun
```

You should see `jarvis_data` with `attached_alloc` empty (no VM yet, that comes in Step 13).

## Step 3. Create the personal Supabase project

1. Go to https://supabase.com/dashboard and create a new project. Name: `jarvis`. Region: pick the one closest to `lax` (typically `us-west-1`). Generate and save the database password to your password manager.
2. Once the project is provisioned, go to Project Settings, API. Copy two values:
   - Project URL (this is `SUPABASE_URL`)
   - `service_role` key under "Project API keys". Note: Supabase is migrating to new keys (`sb_secret_...`). Either the legacy `service_role` JWT or a new `sb_secret_...` key works. Treat this as a high-privilege backend key, never ship it to a client.
3. Apply the schema. Open the SQL Editor in the Supabase dashboard, paste the entire contents of [`supabase/migrations/0001_initial_schema.sql`](../supabase/migrations/0001_initial_schema.sql), and run it. Confirm the tables exist:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see `companies`, `decisions`, `events`, `meetings`, `people`, `scout_applications`, `scout_blacklist`, `scout_criteria`, `scout_jobs`, `scout_recruiters`, `scout_watchlist`, `tasks`.

4. Add to `.env`:

```bash
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste from dashboard>
```

## Step 4. Telegram bot via BotFather

1. On your phone, open Telegram and message [@BotFather](https://t.me/BotFather). Send `/newbot`. Pick a name (e.g. "Jarvis Shaun") and a username ending in `bot` (e.g. `shaun_jarvis_bot`).
2. BotFather replies with an HTTP API token. This is `TELEGRAM_BOT_TOKEN`.
3. Find your personal Telegram chat id. Message [@userinfobot](https://t.me/userinfobot). It replies with your numeric user id. That is `TELEGRAM_ALLOWED_CHAT_IDS` (a comma-separated list; for a single user, just one number).
4. Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_CHAT_IDS=<your numeric chat id>
```

5. Hold off on registering the Telegram webhook. The bot needs a public HTTPS URL, which only exists after Fly deploys the app. Webhook registration is Step 14.

6. Send `/start` to your new bot from your phone now, so the bot has at least one prior message and shows up in your chat list.

## Step 5. Gmail OAuth setup

Jarvis needs a long-lived Gmail refresh token to read recruiter mail and draft replies on Shaun's behalf.

1. Go to https://console.cloud.google.com and create a new project named `jarvis`.
2. Enable the Gmail API: APIs and Services, Library, search "Gmail API", Enable.
3. Configure the OAuth consent screen: User Type "External", App name "Jarvis", User support email and developer email both your own. Under Scopes, add `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`. Add yourself as a Test User. Save.
4. Create credentials: APIs and Services, Credentials, Create Credentials, OAuth client ID. Application type "Desktop app". Name it `jarvis-gmail`. Download the JSON. Note the `client_id` and `client_secret`.
5. Mint the refresh token using a one-shot helper script. We will not write this script as part of the runbook, but the flow is:
   - Local Node script (or `gcloud auth application-default login` with the appropriate scopes) opens the OAuth consent page in a browser.
   - You sign in with your Google account, approve the scopes, and the redirect captures the authorization code.
   - The script exchanges the auth code for tokens using `client_id`, `client_secret`, and the `urn:ietf:wg:oauth:2.0:oob` redirect (or `http://localhost:<port>`).
   - The script prints the resulting `refresh_token`. Copy that value, it does not expire unless you revoke access.
   - Typical scripts: `googleapis` Node library's `oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [...] })` then `oauth2Client.getToken(code)`.
6. Add to `.env`:

```bash
GMAIL_CLIENT_ID=<from credentials JSON>
GMAIL_CLIENT_SECRET=<from credentials JSON>
GMAIL_REFRESH_TOKEN=<from the helper script>
```

## Step 6. Google Calendar OAuth

Same Google Cloud project as Gmail. Different OAuth client (so you can revoke independently if you ever need to).

1. APIs and Services, Library: enable "Google Calendar API".
2. Add scopes to the consent screen: `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/calendar.events`.
3. Create a second OAuth client ID, Desktop app, name `jarvis-calendar`. Download credentials.
4. Run the same refresh-token helper flow as Step 5, with the calendar scopes substituted.
5. Add to `.env`:

```bash
GOOGLE_CALENDAR_CLIENT_ID=<from credentials JSON>
GOOGLE_CALENDAR_CLIENT_SECRET=<from credentials JSON>
GOOGLE_CALENDAR_REFRESH_TOKEN=<from the helper script>
```

If you want to reuse the same OAuth client for both Gmail and Calendar to save a step, that works too. Just add both scopes to one client and use the same `client_id`, `client_secret`, and `refresh_token` for both env var pairs.

## Step 7. Fireflies

1. Sign in at https://app.fireflies.ai.
2. Settings, Developer Settings. Generate a new API key. Copy it.
3. Choose a webhook secret. Generate one locally:

```bash
openssl rand -hex 32
```

4. Add to `.env`:

```bash
FIREFLIES_API_KEY=<from Fireflies settings>
FIREFLIES_WEBHOOK_SECRET=<the random hex string>
```

5. Hold off on registering the webhook URL in Fireflies until after the first deploy (Step 13). The URL will be `https://jarvis-shaun.fly.dev/webhooks/fireflies`. Once registered in Fireflies, also paste the same `FIREFLIES_WEBHOOK_SECRET` into the Fireflies webhook secret field so signatures verify.

## Step 8. Zep Cloud

1. Sign up at https://www.getzep.com. Free tier covers initial usage; cap is generally around 1,000 messages per user per month with a single project.
2. Create a project named `jarvis`.
3. Project settings, API keys. Create a new key, copy it.
4. Add to `.env`:

```bash
ZEP_API_KEY=<from Zep dashboard>
```

If the free tier cap becomes a problem, the migration path is to self-host the Zep Docker container on the same Fly VM. See [`docs/memory.md`](memory.md) for context. Self-hosting is free at our scale but slower to bring up.

## Step 9. Linear API key

1. Go to https://linear.app/settings/api.
2. Create a Personal API key named `jarvis`. Copy it.
3. Add to `.env`:

```bash
LINEAR_API_KEY=<from Linear settings>
```

Jarvis writes meeting action items into Linear via this key, using your own Linear identity. If you'd rather have Jarvis show up as a separate user, create a dedicated Linear user first and generate the key from that account instead.

## Step 10. Browserbase

Jarvis uses Browserbase for the persistent logged-in LinkedIn scraping that Scout relies on.

1. Sign up at https://www.browserbase.com.
2. Create a project named `jarvis`. Note the Project ID.
3. Settings, API Keys. Create a new key.
4. Add to `.env`:

```bash
BROWSERBASE_API_KEY=<from Browserbase>
BROWSERBASE_PROJECT_ID=<project id>
```

5. LinkedIn login (one-time, manual). LinkedIn aggressively rotates challenges, so we use Browserbase's live session to log in once and persist the cookies as a reusable context:
   - In the Browserbase dashboard, open Contexts and create a new context named `linkedin`. Copy the context id.
   - Start a Live Session against that context (Sessions, New Session, attach to `linkedin` context).
   - In the live browser window, navigate to https://www.linkedin.com/login and sign in with Shaun's account. Solve any captchas or device verifications.
   - Close the live session. Browserbase persists the auth cookies in the named context.
   - Use that context id as `LINKEDIN_CONTEXT_ID` in environment variables for Scout. This is not in `.env.example` yet because the Scout MCP server reads it through a module-specific config; track this as a fixup if Scout adds it as a top-level secret.

## Step 11. Claude OAuth token (reused from Bob)

Jarvis shares Bob's Claude Max subscription. The OAuth token gets copied from Bob's Fly app and remounted into Jarvis as a Fly secret.

1. From Bob's Fly app, read the existing secret value. Fly does not let you read secret values directly, so pull it from Bob's running VM:

```bash
fly ssh console --app bob --command "cat /data/claude/credentials.json"
```

(Substitute Bob's actual Fly app name if it's different.)

That file is JSON of the shape `{ "oauth_token": "..." }`. The `oauth_token` field is what Jarvis needs.

2. Capture just the token value:

```bash
fly ssh console --app bob --command "cat /data/claude/credentials.json" \
  | jq -r .oauth_token
```

3. Paste it into `.env`:

```bash
CLAUDE_OAUTH_TOKEN=<the oauth_token value from Bob>
```

`src/runtime/entry.sh` rehydrates `/data/claude/credentials.json` on Jarvis's VM from this env var the first time the volume is empty.

## Step 12. Set all Fly secrets

At this point `.env` should be fully populated. Push every value to Fly as a secret. The secrets listed in [`fly.toml`](../fly.toml) and [`.env.example`](../.env.example) are what's expected at runtime.

Copy-paste this block, replacing each `<placeholder>` with the actual value you've collected:

```bash
fly secrets set --app jarvis-shaun \
  CLAUDE_OAUTH_TOKEN='<from Step 11>' \
  TELEGRAM_BOT_TOKEN='<from Step 4>' \
  TELEGRAM_ALLOWED_CHAT_IDS='<from Step 4>' \
  FIREFLIES_API_KEY='<from Step 7>' \
  FIREFLIES_WEBHOOK_SECRET='<from Step 7>' \
  GMAIL_CLIENT_ID='<from Step 5>' \
  GMAIL_CLIENT_SECRET='<from Step 5>' \
  GMAIL_REFRESH_TOKEN='<from Step 5>' \
  GOOGLE_CALENDAR_CLIENT_ID='<from Step 6>' \
  GOOGLE_CALENDAR_CLIENT_SECRET='<from Step 6>' \
  GOOGLE_CALENDAR_REFRESH_TOKEN='<from Step 6>' \
  LINEAR_API_KEY='<from Step 9>' \
  SUPABASE_URL='<from Step 3>' \
  SUPABASE_SERVICE_ROLE_KEY='<from Step 3>' \
  ZEP_API_KEY='<from Step 8>' \
  BROWSERBASE_API_KEY='<from Step 10>' \
  BROWSERBASE_PROJECT_ID='<from Step 10>'
```

Fly will trigger a restart of any running machines once secrets are set. Since we have not deployed yet, this is a no-op.

Verify:

```bash
fly secrets list --app jarvis-shaun
```

Every entry from the block above should appear with a hash and a timestamp.

## Step 13. First deploy

```bash
fly deploy --app jarvis-shaun
```

The Dockerfile installs Bun, Claude Code CLI, and project deps, then runs `src/runtime/entry.sh` which starts the webhook server on `:3000` and launches `claude --dangerously-skip-permissions --mcp-config /app/config/mcp.json`.

Watch the first boot:

```bash
fly logs --app jarvis-shaun
```

You should see:

- `[jarvis] bootstrapping Claude auth from CLAUDE_OAUTH_TOKEN` on the very first boot (the volume is empty so the credentials file is created from the env var).
- `[jarvis] starting webhook server on :3000`
- `[jarvis] launching Claude Code with --dangerously-skip-permissions`
- Health check `/health` returning 200 on Fly's 30-second interval.

If the machine restart-loops, jump to Troubleshooting.

The public URL is now `https://jarvis-shaun.fly.dev`.

## Step 14. Register the Telegram callback webhook

Tell Telegram where to send incoming messages for your bot. The Channels MCP exposes its callback at `/webhooks/telegram` on the same Bun process.

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://jarvis-shaun.fly.dev/webhooks/telegram",
    "allowed_updates": ["message", "callback_query", "edited_message"]
  }'
```

Confirm:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

You should see your Fly URL and `pending_update_count: 0`.

Now register the Fireflies webhook in the Fireflies dashboard:

- URL: `https://jarvis-shaun.fly.dev/webhooks/fireflies`
- Secret: the value you stored in `FIREFLIES_WEBHOOK_SECRET`
- Events: transcript ready / meeting completed

## Step 15. Seed the watchlist and scoring criteria

The Scout module needs an initial watchlist of companies and a criteria row. The seed script lives at [`scripts/seed-watchlist.ts`](../scripts/seed-watchlist.ts) and is idempotent.

It reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your local environment, not from Fly secrets, because it runs locally against Supabase. Either export them from `.env` or use a tool like `direnv`. Quickest path:

```bash
set -a
source .env
set +a
bun run scripts/seed-watchlist.ts
```

Expected output:

```
[seed] criteria upserted
[seed] watchlist upserted: 16 entries
[seed] done
```

Re-running is safe.

## Step 16. Verification checklist

End-to-end smoke test before declaring victory.

1. Health endpoint returns 200:

```bash
curl https://jarvis-shaun.fly.dev/health
```

2. Telegram round-trip. From your phone, message your bot:

```
/jarvis-status
```

The bot should reply with module status (Scout, MeetingMemory, etc., plus Zep and Supabase connectivity).

3. Fly logs show the Claude Code session is alive and the next scheduled Scout scan is queued:

```bash
fly logs --app jarvis-shaun | grep -iE "scout|cron|scan"
```

4. Database is populated:

```sql
select count(*) from scout_watchlist;     -- expect 16 (from Step 15)
select count(*) from scout_criteria;      -- expect 1
select count(*) from events;              -- grows as Jarvis runs
```

5. Zep collection exists. In the Zep dashboard, under your `jarvis` project, the `shaun` user should appear once Jarvis has written its first memory.

If all five pass, Jarvis is live.

## Troubleshooting

Missing secrets at boot. Symptom: container restarts with "X must be set" errors. Run `fly secrets list --app jarvis-shaun` and compare against the block in Step 12. Set anything missing with `fly secrets set --app jarvis-shaun KEY='value'`. Fly redeploys automatically.

Telegram bot not receiving callbacks. Check `getWebhookInfo` (Step 14). Common causes:

- Webhook URL points at the wrong path (must be `/webhooks/telegram`)
- `last_error_message` in the response shows the actual failure (TLS, 5xx, etc.)
- `TELEGRAM_ALLOWED_CHAT_IDS` does not include your numeric chat id, so the bot is dropping your messages on purpose. Check `fly logs` for `chat_id not allowed`.

Supabase RLS or permissions errors. The schema in `0001_initial_schema.sql` does not enable Row Level Security. The service role key bypasses RLS anyway, so this should be a non-issue. If you see "permission denied for table X", you are most likely using the anon key instead of the service role key in `SUPABASE_SERVICE_ROLE_KEY`. Double-check the value in Project Settings, API.

Zep auth issues. Symptom: `401 Unauthorized` from Zep client. Verify `ZEP_API_KEY` is the project-scoped key (not the personal account key) and that the project name in code matches the Zep project you created. If you hit the free-tier message cap, the failure mode is silent throttling; check the Zep dashboard's usage panel.

Browserbase context expired. LinkedIn invalidates sessions periodically. Symptom: Scout starts logging "session_redirected_to_login" or HTTP 999 from LinkedIn. Re-run the live-session flow in Step 10 against the same `linkedin` context to refresh cookies. The `LINKEDIN_CONTEXT_ID` does not change.

Claude session won't start. Symptom: `[jarvis] launching Claude Code` followed by an auth error. The most likely cause is `CLAUDE_OAUTH_TOKEN` was copied incorrectly (extra whitespace, partial string). Re-run the Step 11 commands and reset the secret. If Bob's token has been rotated, you have to copy the new value.

Volume already attached. Symptom: `fly volumes create` says one already exists. List volumes (`fly volumes list --app jarvis-shaun`); if the existing one is the right size and region, just keep using it.

## Appendix: where things live

- High-level architecture and module map: [`docs/architecture.md`](architecture.md)
- Three-layer memory model and Zep vs Postgres responsibilities: [`docs/memory.md`](memory.md)
- Scout module internals: [`src/modules/scout/README.md`](../src/modules/scout/README.md)
- MeetingMemory module: [`src/modules/meeting/README.md`](../src/modules/meeting/README.md)
- MCP server registry loaded at session start: [`config/mcp.json`](../config/mcp.json)
- Runtime entrypoint (auth bootstrap, webhook server, Claude Code launch): [`src/runtime/entry.sh`](../src/runtime/entry.sh)
- Fly app config including all expected secret names: [`fly.toml`](../fly.toml)
- Env var contract for local dev: [`.env.example`](../.env.example)
- Initial database schema applied in Step 3: [`supabase/migrations/0001_initial_schema.sql`](../supabase/migrations/0001_initial_schema.sql)

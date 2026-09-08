# Cadence

Cadence is a self-hosted, multi-user sales sequencer that sits beside a self-hosted [Twenty CRM](https://twenty.com). Twenty stays the system of record. Cadence is the daily work surface for the outreach team (FOs): it decides who each FO touches today and on which channel, tracks multi-step campaigns across hundreds of people and several pods, and marks steps complete by observing activity that Twenty already syncs.

Cadence never sends email or automates LinkedIn. Humans do every touch.

## What it does

- **Home**: one row of tiles for the signed-in user - people to reach today, calls / emails / LinkedIn due today, accounts owned, relationships owned - and, for managers, the week's board: what each FO owes, a bar for what they have finished, and their replies and meetings (Sunday to Saturday).
- **Tasks**: today / overdue / upcoming by type, filtered by pod and FO. Two ways to work: **List** for picking from a table, and **Task flow** for working a run one person at a time with a progress rail. The step's message is editable in place, so the template is a starting point you personalise before sending from your own mailbox. One row of controls with one panel beneath it: Done, Skip with a reason, Snooze, Open in Twenty, and More for ending the sequence or jumping to another step. Call outcomes with notes, bulk actions across selected rows, keyboard shortcuts.
- **Sequences**: versioned step plans (day offsets, email / call / LinkedIn actions, either/or steps, A/B template variants, templates with `{{firstName}} {{company}} {{jobTitle}} {{eventSource}} {{foFirstName}}`). Editing creates a new version; running enrollments pick it up at their next step. Per-step funnel and per-variant reply stats.
- **Campaigns**: enrol from pasted ids, a CSV export, a saved Twenty view or a bulk selection on People; conflict preview (dnd, opted out, already enrolled, unknown); FO assignment by Twenty owner or round robin; daily ramp; funnel by step and FO; pause / stop / re-enrol non-repliers.
- **Accounts**: one page per firm - a reporting chart built from who reports to whom, each contact's stance on the account (champion, supporter, neutral, detractor), every call, email, meeting, task and campaign anyone there has been part of, and one timeline of the whole relationship. Filter to the accounts you own.
- **Meetings**: paste a recording link and it plays inside Cadence, with the transcript underneath (click a line to seek) and an analysis panel on the right. Media files and SharePoint / OneDrive / Google Drive recordings play in place; Zoom pages and Teams or Meet join links cannot be framed, so those open in a new tab and say so. Analysis is deliberately empty until a model is connected - see [DECISIONS.md](DECISIONS.md).
- **Activity**: everything the team did, newest first, grouped by day, with actor / kind / text filters. Administration (settings, users, pods, logins) is excluded by design.
- **The person panel**, beside every task: how to reach them, their tags and firmographics from Twenty, one merged history of touches, synced emails, CRM notes and sequence events, their colleagues, and a space reserved for the analyzer.
- **People**: fast searchable list from a local cache of Twenty people with Outreach-style stages (Cold, Approaching, Replied, Unresponsive, Bad data, Do not contact), last touch, pod and FO; a person page with the activity timeline, sequence history and controls.
- **Reports**: activity leaderboard per FO, and roll-ups by pod, FO, campaign, sequence and channel; overdue and stalled lists.
- **Twenty integration**: webhooks + nightly reconcile complete email and call steps from Twenty activity, replies close open tasks, meetings and dnd flips are honoured, every completed action is written back as a `[Cadence] ...` note and open tasks are mirrored as Twenty Tasks. `CADENCE_DRY_RUN=true` logs writes without making them.

Server sizing and deploy: [DEPLOY.md](DEPLOY.md). Full list of assumptions: [DECISIONS.md](DECISIONS.md). Connecting a real workspace: [INTEGRATION.md](INTEGRATION.md).

## Quickest start (Windows, no Docker)

Double-click **start-cadence.cmd**. It installs dependencies on the first run, starts an embedded Postgres, applies migrations, seeds the dummy workspace, starts the app and worker, and opens http://localhost:3100/login in your browser. The login page has one-click "sign in as" buttons for the demo users (mock mode only). Close the window to stop; data is kept in `.pgdata-dev`.

The same thing from a terminal: `pnpm start:local`.

**The dummy data** (everything is named "Dummy ..." so it cannot be mistaken for real data): two pods (Alisa's pod, Andrew's pod) plus one discovered from a person's `podOwner` value; one user per role (Admin, Alisa and Andrew as Senior FOs, Karson and Daniel as Junior FOs); three Dummy Companies and sixteen Dummy people; two campaigns per pod (one a week old, one starting today) with enrollments in every state: due today, overdue, replied, bounced, finished, meeting booked, and one dnd person who could not be enrolled; a reporting chart and a stance for every dummy person, so the Accounts relationship map has something to show; and four dummy meetings, one of each kind - a media file that really plays, a SharePoint recording, a Zoom page that has to open in a new tab, and a Google Meet join link - two of them with transcripts. To start over, delete `.pgdata-dev` and launch again.

**Pods follow Twenty.** Which pod a person is in comes from Twenty's `podOwner` field: unknown values create pods automatically, option labels renamed in Twenty rename the pod here. Admins decide which FOs work each pod and who can log in (Settings > Users and pods). What Cadence writes back to Twenty is spelled out in [INTEGRATION.md](INTEGRATION.md#what-cadence-writes-to-twenty-and-what-it-never-touches): only `[Cadence]` activity notes and mirrored tasks, never person fields.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, schema, auth and roles, mock Twenty client, seed with the default sequence | done |
| 2 | Enrollment engine, clocks, caps, versioning | done |
| 3 | Tasks page and brief | done |
| 4 | Webhook ingestion, matching, completions, replies, Twenty sync out | done |
| 5 | Sequences, Campaigns, People, Reports pages | done |
| 6 | Real Twenty client, verify:schema, dry run, docs | done |

## Stack

TypeScript, Node 20, Next.js 15 (App Router, server actions), Postgres 18, Prisma 6, Tailwind 3, Vitest 3, Playwright, Docker Compose. Tests run on an embedded Postgres 18, so no Docker is needed to run them. Verified against Twenty 1.23.

## Run on Windows with Docker Desktop

1. Install Docker Desktop and make sure it is running.
2. Copy `.env.example` to `.env`. The defaults run against the built-in dummy Twenty workspace, so nothing else is required for a first look.
3. In PowerShell, from this folder:

   ```powershell
   docker compose up -d --build
   ```

4. Open http://localhost:3100 and sign in with `admin@cadence.local` / `admin12345` (from `.env`), or use the one-click demo buttons (Alisa and Andrew are Senior FOs, Karson and Daniel Junior FOs, Ria a second Admin; all `password123`).
5. Open Tasks: the dummy workspace already has work due today, overdue work, and replies to look at.

The `web` container applies migrations and runs the seed on start (`SEED_ON_START=true`, idempotent). The `worker` container runs the scheduler every `WORKER_TICK_SECONDS`, the nightly reconcile at `RECONCILE_HOUR` and the cache refresh at `CACHE_REFRESH_HOUR`. Postgres is published on `localhost:5433` so it never collides with Twenty's own database.

Useful commands:

```powershell
docker compose logs -f web worker            # follow logs
docker compose exec web pnpm verify:schema   # check the Twenty field mapping
docker compose exec web pnpm reconcile 7     # replay the last 7 days of Twenty activity
docker compose down                          # stop (data is kept in the cadence-db volume)
docker compose down -v                       # stop and delete data
```

## Run on the Linux server

Same compose file, unchanged:

```bash
cp .env.example .env
# edit .env:
#   TWENTY_MODE=graphql  TWENTY_API_URL=https://twenty.example.com  TWENTY_API_KEY=...
#   SESSION_SECRET=<long random>  COOKIE_SECURE=true  APP_URL=https://cadence.example.com
#   SEED_PROFILE=core  ADMIN_EMAIL=you@company.com  ADMIN_PASSWORD=<strong>
#   CADENCE_DRY_RUN=true  (for the pilot)
#   TWENTY_WEBHOOK_SECRET=... or CADENCE_WEBHOOK_TOKEN=...
docker compose up -d --build
```

Put a reverse proxy (Caddy, nginx, Traefik) in front of port 3100 with TLS, then follow [INTEGRATION.md](INTEGRATION.md): API key, webhooks, `verify:schema`, pods and users, dry run, pilot with one pod, then turn dry run off.

## Local development (no Docker)

You need Node 20+ and pnpm 9 (`corepack enable` or `npm i -g pnpm`). The app itself needs a Postgres: `docker compose up -d db` gives you one on port 5433, `pnpm dev:db` starts an embedded one on port 5434 with no Docker at all (data in `.pgdata-dev`), or point `DATABASE_URL` at your own.

```bash
pnpm install
cp .env.example .env
pnpm db:migrate          # apply migrations
pnpm db:seed             # default sequence, admin, demo pods/users/people (mock mode)
pnpm dev                 # http://localhost:3000
pnpm worker              # scheduler + nightly jobs, in a second terminal
```

Tests need neither Docker nor a running Postgres: `pnpm test` starts an embedded Postgres, applies the migrations, and runs everything against the mock Twenty client. Set `TEST_DATABASE_URL` to use an existing database instead.

```bash
pnpm typecheck     # TypeScript
pnpm lint          # ESLint (Next core-web-vitals + TypeScript rules)
pnpm test          # Vitest on an embedded Postgres (engine, ingestion, queries, GraphQL client)
pnpm test:e2e      # Playwright: builds, starts the app on a fresh database, drives real browser flows
pnpm screens       # captures every screen to .screens/ for design review
pnpm build
```

The end-to-end suite covers demo sign-in, campaign creation with the conflict preview, the task flow (done, log a call with an outcome, skip with a bounce, answered call finishing as replied), sequence editing, settings, role restrictions, reports and the people pages.

## Roles

| | Admin | Senior FO | Junior FO |
|---|---|---|---|
| Own tasks: complete, skip with reason, snooze | yes | yes | yes (snooze to next working day only) |
| Pod tasks, pod filters | all pods | own pods | no |
| Enrol, bulk-enrol, pause, exit, reassign within pod | all pods | own pods | no |
| Campaigns | all | own pods | read-only own enrollments |
| Reports | all | own pods | no |
| Sequences (edit, versions) | yes | view | view |
| Settings, users, pods | yes | no | no |
| Accounts, Meetings, Activity | all | own pods' accounts | own work |

Settings is the only admin-only section: it is hidden from the sidebar and refuses direct URLs for anyone else.

## Layout

```
prisma/                 schema, migrations (hand-added partial unique index), seed
scripts/                verify-schema.ts, reconcile.ts
src/app/                Next.js routes: home, tasks, accounts, people, meetings, sequences, campaigns,
                        activity, replies, reports, settings, api/webhooks/twenty
src/components/         UI (no component library; inline SVG icons)
src/lib/auth/           sessions, passwords, RBAC
src/lib/engine/         clock, caps, versioning, tasks, enrollment, matching, ingest, reconcile, sync-out
src/lib/meetings/       recording-link parsing, transcript parsing, the analyzer seam
src/lib/sequences/      step schema and the default 23-day sequence
src/lib/twenty/         twenty-schema.ts (all field names), types, client interface, mock + fixtures,
                        graphql-client.ts (all queries), normalize, webhook-auth, urls
src/worker/             scheduler process
e2e/                    Playwright: behaviour suite and the screenshot capture
tests/                  vitest on embedded Postgres 18, including a per-page query budget
```

## The default sequence

| Day | Actions |
|---|---|
| 1 | Email 1, LinkedIn connect |
| 3 | Call 1, then email OR LinkedIn message |
| 6 | Email 2 |
| 9 | LinkedIn message 2 |
| 12 | Call 2, then email OR LinkedIn message |
| 16 | LinkedIn message 3 |
| 20 | Call 3, then email OR LinkedIn message |
| 23 | Email 3 |

Seeded as version 1 of "Default outbound (23 days)". Admins edit it in Sequences.

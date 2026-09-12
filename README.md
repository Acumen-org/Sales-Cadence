# Cadence

Cadence is a self-hosted, multi-user sales sequencer that sits beside a self-hosted [Twenty CRM](https://twenty.com). Twenty stays the system of record. Cadence is the daily work surface for the outreach team (FOs): it decides who each FO touches today and on which channel, tracks multi-step campaigns across hundreds of people and several pods, and marks steps complete by observing activity that Twenty already syncs.

Cadence never sends email or automates LinkedIn. Humans do every touch.

Current requirement-by-requirement findings and live deployment limitations: [CURRENT-REQUIREMENTS-AUDIT.md](CURRENT-REQUIREMENTS-AUDIT.md).

## What it does

- **Home**: one row of tiles for the signed-in user - people to reach today, calls / emails / LinkedIn due today, accounts owned, relationships owned - and, for managers, the week's board: what each FO owes, a bar for what they have finished, and their replies and meetings (Sunday to Saturday).
- **Tasks**: today / overdue / upcoming by type, filtered by pod and FO. Two ways to work: **List** for picking from a table, and **Task flow** for working a run one person at a time with a progress rail. The step's message is editable in place, so the template is a starting point you personalise before sending from your own mailbox. One row of controls with one panel beneath it: Done, Skip with a reason, Snooze, Open in Twenty, and More for ending the sequence or jumping to another step. Call outcomes with notes, bulk actions across selected rows, keyboard shortcuts.
- **Sequences**: one editable plan per sequence. A step is a business day offset and the modules on it - email, call, LinkedIn; steps drag into order, modules are added to a step with a button; one step can hold a call and its follow-up email, and both appear inside that person's task. Supported template tokens are expanded when each task is created; the task shows personalised copy. An optional repeat gap restarts follow-up after the final step. There are no versions: edit a step whenever you like and every enrollment sees it, except a step with open tasks on it, which is refused until those are worked or cancelled - each task keeps its own frozen copy of the action, so an edit can never rewrite the message an FO is looking at. Days count business days only, so day 1 on a Monday makes day 7 the following Tuesday. The library shows each sequence as its full flow with one number: how many campaigns use it. Per-step funnel in Reports.
- **Campaigns**: enrol from pasted ids, a CSV export, a saved Twenty view or a bulk selection on People; conflict preview (dnd, opted out, already enrolled, unknown); FO assignment by Twenty owner or round robin; daily ramp; funnel by step and FO; pause / stop / re-enrol non-repliers.
- **Accounts**: one page per firm - the CRM record as labelled fields (industry, city, employees, AUM, owner, last synced), the people grouped into bands by the job titles Twenty holds, every call, email, meeting, task and campaign anyone there has been part of, and one timeline of the whole relationship. Filter to the accounts you own.
- **Meetings**: paste a recording link and it plays inside Cadence, with the transcript underneath (click a line to seek) and an analysis panel on the right. Recordings Twenty already holds on a person record are listed separately with an "Add with recording" that pre-fills the form from that person. Media files and SharePoint / OneDrive / Google Drive recordings play in place; Zoom pages and Teams or Meet join links cannot be framed, so those open in a new tab and say so. Analysis is deliberately empty until a model is connected - see [DECISIONS.md](DECISIONS.md).
- **Enrichment**: what is missing before this data can be worked - a contact with no email is critical, an account with no AUM is useful - filterable by priority and by field. Enrichment you are given arrives as a CSV or JSON import: Cadence parses it, maps the columns, matches each row by Twenty id, email or domain, shows what would change, refuses a row whose CRM value moved since the preview, writes it to Twenty and verifies what Twenty returned.
- **Activity**: everything the team did, newest first, grouped by day, with actor / kind / text filters. Administration (settings, users, pods, logins) is excluded by design.
- **The person panel**, beside every task: how to reach them, **what Twenty says to do next** (the pod's own "FU-2, due Thursday, by email", which Cadence reads and never overwrites), how Twenty classifies them (tier, contact type, expected cadence, pipeline stage, product interest, campaigns, lead source), their tags, any booked meeting, one merged history of touches, synced emails, CRM notes and sequence events, their colleagues, and the Cadence AI panel.
- **People**: fast searchable list from a local cache of Twenty people, filtered on what the CRM actually holds - pod, tier, contact type - plus the sequence state Cadence itself knows. Each row shows Twenty's standing and tier, Twenty's next action and its due date, the sequence, recent activity, owner and last touch. A person page opens on Overview - the whole Twenty record grouped the way Twenty groups it, and the campaign they are in now or how the last one ended - with their full campaign history, their activity, and Twenty's own emails and notes on the tabs beside it.
- **Reports**: activity leaderboard per FO, and roll-ups by pod, FO, campaign, sequence and channel, over any date range you ask for (28 days by default).
- **Twenty integration**: every field name and option value the app relies on lives in one file (`src/lib/twenty/twenty-schema.ts`) and matches the real workspace - ownership is `assignedTo`, consent is the `dnd` select, "where we met" is the `leadSource` multi-select. Webhooks, continuous sync (60 seconds by default) and nightly reconciliation complete email and call steps from Twenty activity, replies close open tasks, a new opportunity marks a meeting, dnd is honoured, every completed action is written back as a `[Cadence] ...` note and open tasks are mirrored as Twenty Tasks. Option constants are shown as readable labels, never raw. `CADENCE_DRY_RUN=true` logs writes without making them. Field-by-field mapping: [INTEGRATION.md](INTEGRATION.md#4-confirm-field-names).

Server sizing and deploy: [DEPLOY.md](DEPLOY.md). Full list of assumptions: [DECISIONS.md](DECISIONS.md). Connecting a real workspace: [INTEGRATION.md](INTEGRATION.md).

## Quickest start (Windows, no Docker)

Double-click **start-cadence.cmd**. It installs dependencies on the first run, starts an embedded Postgres, applies migrations, seeds, starts the app and worker, and opens http://localhost:3100/login. Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you put in `.env`. Close the window to stop; data is kept in `.pgdata-dev`.

With `TWENTY_MODE=mock` the launcher runs against a built-in sample workspace instead of your CRM, which is how the test suites work and how to look around without touching real data. A real install sets `TWENTY_MODE=graphql`.

The same thing from a terminal: `pnpm start:local`. Each launch builds the current source before serving it. Set `CADENCE_SKIP_BUILD=1` only when deliberately reusing a build you just made. Database directories must be direct subdirectories of the project; the launcher refuses a running database or a nonempty, uninitialized directory instead of deleting files.

**A sample workspace for local work.** With `TWENTY_MODE=mock` and `SEED_PROFILE=core,demo`, the seed builds a workspace named entirely with "Dummy ..." so it cannot be mistaken for real data: two pods, one account per role, sixteen contacts carrying the real shape of the CRM record, campaigns with enrollments in every state, and four meetings with recordings and transcripts. This is what the test suites run against. It is never created in `graphql` mode, and `SEED_PROFILE=core` - the default - does not build it. To start over, delete `.pgdata-dev` and launch again.

**Pods follow Twenty.** Which pod a person is in comes from Twenty's `podOwner` field: unknown values create pods automatically, option labels renamed in Twenty rename the pod here. Admins decide which FOs work each pod and who can log in (Settings > Users and pods). What Cadence writes back to Twenty is spelled out in [INTEGRATION.md](INTEGRATION.md#what-cadence-writes-to-twenty-and-what-it-never-touches): `[Cadence]` activity notes, mirrored tasks, and the fields an admin or pod leader imports through Enrichment. Nothing else is ever written.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, schema, auth and roles, mock Twenty client, seed with the default sequence | done |
| 2 | Enrollment engine, clocks, caps | done |
| 3 | Tasks page and brief | done |
| 4 | Webhook ingestion, matching, completions, replies, Twenty sync out | done |
| 5 | Sequences, Campaigns, People, Reports pages | done |
| 6 | Real Twenty client, verify:schema, dry run, docs | done |

## Stack

TypeScript, Node 20+, Next.js 15 (App Router, server actions), Postgres 18, Prisma 6, Tailwind 3, Vitest 4, Playwright, Docker Compose. Tests run on an embedded Postgres 18, so no Docker is needed to run them. The existing integration targets Twenty 1.23; check your live workspace with `pnpm verify:schema`.

## Run on Windows with Docker Desktop

1. Install Docker Desktop and make sure it is running.
2. Copy `.env.example` to `.env` and fill in `TWENTY_API_URL`, `TWENTY_API_KEY`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. There is no default admin password: the seed refuses to create the first account without one.
3. In PowerShell, from this folder:

   ```powershell
   docker compose up -d --build
   ```

4. Open http://localhost:3100 and sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`. Change that password from Settings, then add the rest of the team there. If the admin password is ever lost, `pnpm admin:password -- <email> <new password>` on the server sets a new one.
5. Pods and contacts arrive from Twenty on their own; see [INTEGRATION.md](INTEGRATION.md) for the webhook and the field check.

The `web` container applies migrations and runs the seed on start (`SEED_ON_START=true`, idempotent). The `worker` container syncs from Twenty every `CRM_SYNC_SECONDS`, runs the scheduler every `WORKER_TICK_SECONDS`, and once a day after `RECONCILE_HOUR` (US Central) re-scans recent Twenty activity for anything a webhook missed and refreshes the person cache in full. Postgres is published on `localhost:5433` so it never collides with Twenty's own database.

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
#   COOKIE_SECURE=true  APP_URL=https://cadence.example.com
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
pnpm db:seed             # the default sequence and the admin account from .env
pnpm db:reset            # empty the workspace: campaigns, tasks, contacts, pods, everyone but the admin
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

The end-to-end suite covers sign-in, campaign creation with the conflict preview, the task flow (done, log a call with an outcome, skip with a bounce, answered call finishing as replied), sequence editing including the refusal to change a step in use, settings, role restrictions checked by URL as well as by the missing link, reports, accounts, meeting forms, enrichment, global search, dialog focus, and mobile navigation. `e2e/roles.spec.ts` drives one full journey per role, and `pnpm test:fresh` drives a brand-new deployment: one admin, the default sequence, nothing worked yet. To use a separate browser-test database without clearing an existing one, build first, then set `E2E_DB_DIR` to a new project subdirectory and run `pnpm exec playwright test`.

## Working on it

`main` is the branch that deploys. Every push to it and every pull request runs the whole suite in
GitHub Actions (`.github/workflows/ci.yml`): typecheck, lint, 271 unit tests, 45 browser tests and
the fresh-install check. None of it needs a database server, a Twenty instance or a secret - the
unit tests start an embedded Postgres and the browser tests run against the built-in fake CRM - so
a fork or a clean runner builds green with no configuration.

Before pushing, the same thing locally:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

**The `handover` tag** marks the commit the dev team received (`b9b0089`). If the GitHub
repository contains that commit, histories on both sides share an ancestor and work done in
parallel merges normally: add the remote, `git fetch`, then rebase or open a pull request. If it
does not — because the repository was started fresh from the files rather than pushed from this
one — the two histories are unrelated, and combining them needs a deliberate
`--allow-unrelated-histories` merge or a replay of one side's commits onto the other. Easier to
push this history in the first place than to reconcile later.

Two things worth setting up on the repository itself, which cannot live in the code:

- **Protect `main`**: require the CI check to pass before merging. Settings > Branches.
- **Decide about Dependabot.** This app holds a copy of your CRM's contact data, so security
  updates matter; weekly npm and Actions updates are the usual setting.

**Schema changes** ship as migrations. `prisma/migrations/` is committed, `pnpm db:migrate` applies
what is missing, and the Docker entrypoint runs it on start - so deploying a schema change is the
same as deploying anything else. Never edit a migration that has run somewhere; add another.

## Workspace design and review

Cadence uses a warm canvas, evergreen navigation, lime accents, a custom mark, and a consistent set of cards, tables, controls, and record headers. Home combines personal priorities, a focused task-flow entry point, upcoming touches, and weekly team performance. Sequences have a searchable visual library with real touch plans. Search (`Ctrl+K` / `Cmd+K`) and help are available from every section; the sidebar becomes a keyboard-accessible drawer on mobile.

The project review and its verification scope are recorded in [AUDIT.md](AUDIT.md). Meeting times are entered in the one workspace timezone, US Central. Meeting analysis and suggested approaches remain explicitly unconnected until a model provider is implemented.

## Roles

| | Admin | Sales Leader / Pod Manager | Senior FO | Junior FO | Biz Ops |
|---|---|---|---|---|---|
| Own tasks: complete, skip with reason, snooze | yes | yes | yes | yes (snooze to next working day only) | no |
| Pod tasks, pod filters | all pods | own pods | own pods | no | all pods, read only |
| Enrol, bulk-enrol, pause, exit, reassign, delegate within pod | all pods | own pods | own pods | no | no |
| Campaigns | all | own pods, approves re-enrolment | own pods | read own pod's | read all |
| Reports | all | own pods | own pods | no | all pods |
| Sequences (edit the plan) | yes | yes | yes | view | view |
| Settings, users, pods | yes | no | no | no | no |
| People, Accounts, Meetings, Activity | all | own pods | own pods | own work | all pods |

Settings is the only admin-only section: it is hidden from the sidebar and refuses direct URLs for anyone else.

Every sales role belongs to at least one pod (the form insists); Biz Ops and Admin need none. Team
members are never listed as contacts, even when Twenty holds them as people.

**What a section opens on.** A junior opens Tasks, Activity and Reports on their pod and their own
name; anyone who leads a pod opens their pod; admins and Biz Ops open everything. Choosing "All"
in a filter is remembered in the URL for that visit, so it does not snap back on the next click.

## Sequences that repeat, copy that fills itself in, and handing a touch to a colleague

- **Nurture.** A sequence can *repeat after N working days*. When its last step is worked, the same
  people start again N working days later as the next round of the same campaign, until they reply,
  book a meeting, ask not to be contacted or are removed. Build one sequence ("Check in every three
  weeks"), add people through a campaign, and the follow-up runs itself.
- **Copy tokens.** Module copy may say `{{firstName}}`, `{{lastName}}`, `{{fullName}}`,
  `{{company}}`, `{{jobTitle}}`, `{{city}}`, `{{foFirstName}}` or `{{foName}}`. They are filled in
  for the person when the task is created ("there" and "your firm" stand in for a blank record), so
  the FO reads a finished message and never a token.
- **Delegate.** A pod leader or manager can hand one touchpoint - every open module of it - to a
  pod-mate from the task's *More* panel. The enrollment keeps its FO; the mirrored Twenty task
  moves with the touchpoint.
- **Picking people for a campaign.** *Pick from People* on the campaign form is the directory with
  its filters (pod, FO, product interest, tier, type, sequence state, search) and tick boxes; the
  ids travel the same way pasted ids always did.
- **Filters and search.** People and Accounts filter by pod, FO and product interest and sort;
  search matches every word you type across name, company, email, phone, title and city.
- **Transcripts.** WebVTT, SRT, Teams' grouped text, a JSON export (Teams, Zoom and the like) or
  plain text, pasted or uploaded as a file. Only the dialogue is kept, and the transcript follows
  the recording when it plays here.

## Layout

```
prisma/                 schema, migrations (hand-added partial unique index), seed
scripts/                verify-schema.ts, reconcile.ts
src/app/                Next.js routes: home, tasks, accounts, people, meetings, sequences, campaigns,
                        activity, replies, reports, settings, api/webhooks/twenty
src/components/         UI (no component library; inline SVG icons)
src/lib/auth/           sessions, passwords, RBAC
src/lib/engine/         clock, caps, sequence-plan, tasks, enrollment, matching, ingest, reconcile, sync-out
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
| 3 | Call 1 + follow-up email |
| 6 | Email 2 |
| 9 | LinkedIn message 2 |
| 12 | Call 2 + LinkedIn message |
| 16 | LinkedIn message 3 |
| 20 | Call 3 + follow-up email |
| 23 | Email 3 |

Seeded as "Default outbound". Days are business days, so this runs over roughly five calendar weeks. Senior FOs and above edit it in Sequences; a step with open tasks on it is locked until those are worked.

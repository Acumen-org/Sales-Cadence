# Cadence

Cadence is a self-hosted, multi-user sales sequencer that sits beside a self-hosted [Twenty CRM](https://twenty.com). Twenty stays the system of record. Cadence is the daily work surface for the outreach team (FOs): it decides who each FO touches today and on which channel, tracks multi-step campaigns across hundreds of people and several pods, and marks steps complete by observing activity that Twenty already syncs.

Cadence never sends email or automates LinkedIn. Humans do every touch.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, schema, auth and roles, mock Twenty client, seed with the default sequence | done |
| 2 | Enrollment engine, clocks, caps, versioning | done |
| 3 | Tasks page and brief | done |
| 4 | Webhook ingestion, matching, completions, replies, Twenty sync out | done |
| 5 | Sequences, Campaigns, People, Reports pages | pending |
| 6 | Real Twenty client, verify:schema, dry run, docs | pending |

## Stack

TypeScript, Node 20, Next.js (App Router, server actions), Postgres, Prisma, Tailwind, Vitest, Docker Compose.

## Run on Windows with Docker Desktop

1. Install Docker Desktop and make sure it is running.
2. Copy `.env.example` to `.env`. The defaults run against the built-in mock Twenty workspace, so nothing else is required for a first look.
3. In PowerShell, from this folder:

   ```powershell
   docker compose up -d --build
   ```

4. Open http://localhost:3100 and sign in with `admin@cadence.local` / `admin12345` (from `.env`), or one of the demo users (`alisa@cadence.local`, `leigh@cadence.local`, `andrew@cadence.local`, `karson@cadence.local`, `daniel@cadence.local`, `ria@cadence.local`, all `password123`).

The `web` container applies migrations and runs the seed on start (`SEED_ON_START=true`). The `worker` container runs the scheduler and nightly jobs. Postgres is published on `localhost:5433` so it never collides with Twenty's own database.

Useful commands:

```powershell
docker compose logs -f web worker      # follow logs
docker compose down                    # stop (data is kept in the cadence-db volume)
docker compose down -v                 # stop and delete data
```

## Run on the Linux server

Same compose file, unchanged:

```bash
cp .env.example .env
# edit .env: TWENTY_MODE=graphql, TWENTY_API_URL, TWENTY_API_KEY, SESSION_SECRET, COOKIE_SECURE=true, SEED_PROFILE=core
docker compose up -d --build
```

Put a reverse proxy (Caddy, nginx, Traefik) in front of port 3100 with TLS, then register the webhook URL in Twenty as described in [INTEGRATION.md](INTEGRATION.md). Start with `CADENCE_DRY_RUN=true` and one pod.

## Local development (no Docker)

You need Node 20+ and pnpm 9 (`corepack enable` or `npm i -g pnpm`). A Postgres is needed for the app itself; `docker compose up -d db` is the quickest way to get one on port 5433.

```bash
pnpm install
cp .env.example .env
pnpm db:migrate          # apply migrations
pnpm db:seed             # default sequence, admin, demo pods/users/people (mock mode)
pnpm dev                 # http://localhost:3000
pnpm worker              # scheduler + nightly jobs, in a second terminal
```

Tests do not need Docker or a running Postgres: `pnpm test` starts an embedded Postgres, applies the migrations, and runs everything against the mock Twenty client. Set `TEST_DATABASE_URL` to use an existing database instead.

```bash
pnpm typecheck
pnpm test
```

## Layout

```
prisma/               schema, migrations, seed
src/app/              Next.js routes (App Router)
src/components/       UI
src/lib/auth/         sessions, passwords, RBAC
src/lib/engine/       enrollment engine: clocks, caps, tasks, ingestion, reconcile, sync out
src/lib/sequences/    step schema and the default sequence
src/lib/twenty/       twenty-schema.ts (all field names), client interface, mock, GraphQL client
src/worker/           scheduler process
scripts/              verify:schema, reconcile
tests/                vitest (embedded Postgres)
```

See [DECISIONS.md](DECISIONS.md) for every assumption and [INTEGRATION.md](INTEGRATION.md) for connecting a real Twenty workspace.

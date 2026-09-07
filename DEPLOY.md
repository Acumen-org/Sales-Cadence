# Cadence: server brief

One page for whoever runs the server. Detail lives in [README.md](README.md) (usage), [INTEGRATION.md](INTEGRATION.md) (Twenty), [DECISIONS.md](DECISIONS.md) (why).

## What it is

A self-hosted web app that sits **beside** Twenty CRM and tells the outreach team who to contact today. It never sends email and never automates LinkedIn; people do every touch and Cadence records it. Twenty stays the system of record.

Standard boring stack, nothing exotic:

- **Next.js 15** (React, App Router, server actions) — the web app and the webhook endpoint, one Node process.
- **A worker** — a second Node process: generates due tasks every 5 min, nightly reconcile with Twenty, cache refresh.
- **Postgres 16** — Cadence's own database (sequencing state, a read cache of Twenty people, an audit log). Separate from Twenty's database.
- **Prisma** for the schema and migrations. TypeScript throughout.

```
Browser ──► Next.js (web, :3000) ──► Postgres
                 ▲     │
   Twenty ───────┘     └──────────► Twenty GraphQL API
   webhooks                          (reads; writes only [Cadence] notes + mirrored tasks)
                 Worker ──► Postgres + Twenty API
```

Integration with Twenty is **read-mostly**: it reads people, notes, messages, tasks and opportunities; it writes back only `[Cadence] ...` activity notes and mirrored tasks. It never edits CRM fields. `CADENCE_DRY_RUN=true` disables all writes.

## Specs

Three containers: `web`, `worker`, `db`. Measured at idle with the demo dataset: web 103 MB, worker 133 MB, Postgres 99 MB — about **340 MB total**. Under real load budget ~1 GB.

The peak is the **build**, not the running app. `next build` scales workers to CPU count; it peaked at 3.5 GB on an 8-core dev machine, so expect roughly 1.5–2 GB on a 2-core VPS.

| | Spec | Notes |
|---|---|---|
| **Recommended** | 2 vCPU, 8 GB RAM, 50 GB SSD | Hostinger **KVM 2**. Builds on the server without tuning. |
| **Minimum** | 2 vCPU, 4 GB RAM, 40 GB SSD | Hostinger **KVM 1** is 1 vCPU/4 GB: fine to *run*, tight to *build*. Add 2 GB swap, or build elsewhere (below). |
| **Won't work** | Shared / web hosting | Needs root and Docker. Not a PHP app. |

Sizing barely moves with team size: 10 FOs and 100 FOs are the same order of work. Disk: the app image is ~2 GB, the database grows slowly (tens of MB per year for a few thousand people). 50 GB is plenty.

**If you want a 4 GB box:** build the image on a dev machine or CI, push to a registry, and have the server only `docker compose pull && up`. Then the server needs ~1 GB and never runs a build.

**If Twenty is on the same server**, add Twenty's own requirements (it is heavier than Cadence: its own Postgres, Redis and worker). Give the pair 8–16 GB, i.e. KVM 2 or KVM 4. Cadence publishes Postgres on host port **5433** specifically so it does not collide with Twenty's.

Also needs: Docker + Docker Compose, a domain or subdomain, TLS via a reverse proxy (Caddy or nginx), outbound HTTPS to the Twenty API, and inbound HTTPS so Twenty can POST webhooks.

## Deploy

```bash
git clone <repo> cadence && cd cadence
cp .env.example .env
# edit .env: TWENTY_MODE=graphql, TWENTY_API_URL, TWENTY_API_KEY,
#            SESSION_SECRET=<long random>, COOKIE_SECURE=true,
#            APP_URL=https://cadence.example.com, SEED_PROFILE=core,
#            ADMIN_EMAIL/ADMIN_PASSWORD, CADENCE_DRY_RUN=true (for the pilot)
docker compose up -d --build      # first build ~5 min
```

Web listens on **3100** (host) → 3000 (container). Point the reverse proxy at it. Migrations and the seed run automatically on start.

Then follow [INTEGRATION.md](INTEGRATION.md): create the Twenty API key, register webhooks at `https://<host>/api/webhooks/twenty`, run `docker compose exec web pnpm verify:schema`, pilot one pod with dry run on, then set `CADENCE_DRY_RUN=false`.

## Running it

```bash
docker compose logs -f web worker           # logs
docker compose exec web pnpm verify:schema  # check the Twenty field mapping
docker compose exec web pnpm reconcile 7    # replay 7 days of Twenty activity (safe, idempotent)
docker compose up -d --build                # deploy an update
```

- **Health check:** `GET /api/health` returns `{"ok":true,"db":"up"}`.
- **Backup:** only Postgres holds state. `docker compose exec db pg_dump -U cadence cadence | gzip > backup.sql.gz`, nightly. Everything else is rebuildable from git.
- **Restart safety:** both processes are stateless; the worker's jobs are idempotent, so a restart mid-job is harmless.
- **Secrets:** `.env` only. `SESSION_SECRET` must be long and random; `TWENTY_API_KEY` grants full CRM access, so keep the file `chmod 600`.
- **Scaling:** one web container handles this workload comfortably. If it ever needs more, run several `web` containers behind the proxy; the worker must stay a **single** instance (it is the scheduler).

## Gotchas

- The webhook endpoint is public. Set `TWENTY_WEBHOOK_SECRET` (HMAC) or at least `CADENCE_WEBHOOK_TOKEN`, otherwise anything can POST to it.
- `SEED_PROFILE=core` in production. Leaving `demo` in creates sixteen "Dummy" people.
- Node 20 in the image; the host's Node version is irrelevant since everything runs in Docker.

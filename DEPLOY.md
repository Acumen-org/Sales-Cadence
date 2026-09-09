# Cadence: server brief

One page for whoever runs the server. Detail lives in [README.md](README.md) (usage), [INTEGRATION.md](INTEGRATION.md) (Twenty), [DECISIONS.md](DECISIONS.md) (why).

## What it is

A self-hosted web app that sits **beside** Twenty CRM and tells the outreach team who to contact today. It never sends email and never automates LinkedIn; people do every touch and Cadence records it. Twenty stays the system of record.

Standard boring stack, nothing exotic:

- **Next.js 15** (React, App Router, server actions) — the web app and the webhook endpoint, one Node process.
- **A worker** — a second Node process: generates due tasks every 5 min, nightly reconcile with Twenty, cache refresh.
- **Postgres 18** — Cadence's own database (sequencing state, a read cache of Twenty people and companies, meetings and transcripts, an audit log). Separate from Twenty's database. 16 and 17 also work.
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

Three containers: `web`, `worker`, `db`. Measured with the demo dataset after serving 200 page renders: **~720 MB** across all three (Node ~450 MB for the web app and worker together, Postgres ~85 MB of private memory plus its shared buffers). Idle is lower; a working set does not shrink on its own after load. Budget ~1 GB.

CPU is not the constraint. 200 page renders cost **3.8 seconds of CPU in total**, about 19 ms per page, and warm pages render in 20–95 ms. One vCPU therefore has roughly 50 renders a second of headroom, far more than a team of FOs can generate. Every page issues a fixed number of queries no matter how much data there is, and a test enforces it (`tests/query-budget.test.ts`): the heaviest is the task screen's person panel at 18, unchanged when the row count triples.

The peak is the **build**, not the running app. Compose builds with one worker and a 1536 MB heap ceiling, and skips type checking (run `pnpm typecheck` in CI instead), which keeps the build inside a 2 GB box. Left unconstrained, `next build` scales to CPU count and peaked at 3.5 GB on an 8-core machine.

| | Spec | Notes |
|---|---|---|
| **Recommended** | 2 vCPU, 8 GB RAM, 50 GB SSD | Hostinger **KVM 2**. Builds on the server with room to spare. |
| **Works** | 1 vCPU, 2 GB RAM, 40 GB SSD | Runs comfortably at ~370 MB. The build fits because it is capped, but it is slow (5–10 min); add 2 GB swap or build elsewhere (below). |
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

The Postgres 18 volume mounts at `/var/lib/postgresql` (the image keeps its cluster in `18/docker`), and its published port binds to `127.0.0.1`. Local databases, environment overrides, screenshots, and review artifacts are excluded from the Docker build context. For an existing deployment with a volume at the old `/var/lib/postgresql/data` path, take a database backup and confirm the actual cluster location before changing the mount; the Compose edit does not migrate existing data. See the [official image's volume layout](https://github.com/docker-library/postgres/blob/master/18/alpine3.23/Dockerfile).

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
- Meeting recordings are **not** stored by Cadence: it keeps the link, the transcript text and any analysis. Playback streams from wherever the recording lives (SharePoint, Drive, your own file host), so viewers must be able to reach it and be signed in to Microsoft 365 or Google where that applies. Disk use stays tiny.
- Postgres is deliberately tuned small in `docker-compose.yml` (`shared_buffers=192MB`, `work_mem=8MB`, `jit=off`) and Prisma's pool is capped (`connection_limit=6` web, `4` worker). If you move to a bigger box, raise those rather than leaving the defaults: Prisma's default pool is `cores * 2 + 1`, which opens far more Postgres backends than this workload needs.

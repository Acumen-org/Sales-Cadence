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

Integration with Twenty is **read-mostly**: it reads people, notes, messages, tasks and opportunities; it writes back `[Cadence] ...` activity notes and mirrored tasks, and edits CRM fields only through Enrichment imports an admin reviews and applies. A write Twenty refuses is kept and retried (Settings > Activity log). `CADENCE_DRY_RUN=true` disables all writes.

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
#            COOKIE_SECURE=true,
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
docker compose exec web pnpm sync:diagnose  # why data is missing: counts, each listing, last sync
LIVE_URL=https://<host> LIVE_EMAIL=... LIVE_PASSWORD=... pnpm live:check   # from any machine: walk every section signed in, report counts, errors, screenshots
docker compose exec web pnpm reconcile 7    # replay 7 days of Twenty activity (safe, idempotent)
docker compose up -d --build                # deploy an update
```

- **Health check:** `GET /api/health` returns `{"ok":true,"db":"up"}`.
- **Backup:** only Postgres holds state. `docker compose exec db pg_dump -U cadence cadence | gzip > backup.sql.gz`, nightly. Everything else is rebuildable from git.
- **Restart safety:** both processes are stateless; the worker's jobs are idempotent, so a restart mid-job is harmless.
- **Secrets:** `.env` only. `TWENTY_API_KEY` grants full CRM access, so keep the file `chmod 600`. Sessions are database tokens; there is no signing secret.
- **Lost admin password:** `docker compose exec web pnpm admin:password -- <email> <new password>` sets a new one and signs that account out everywhere.
- **Scaling:** one web container handles this workload comfortably. If it ever needs more, run several `web` containers behind the proxy; the worker must stay a **single** instance (it is the scheduler).

## Gotchas

- Sign-in is Microsoft once an admin saves the app registration under Settings > Sign-in (or the server sets `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`). The registration needs `<APP_URL>/api/auth/microsoft/callback` as a Web redirect URI. Passwords keep working until the first Microsoft sign-in succeeds, then stop. If Microsoft sign-in ever breaks (an expired client secret is the usual cause), set `PASSWORD_SIGN_IN=true` to let the old passwords in while it is fixed.
- The webhook endpoint is public. Set `TWENTY_WEBHOOK_SECRET` (HMAC) or at least `CADENCE_WEBHOOK_TOKEN`, otherwise anything can POST to it.
- `SEED_PROFILE=core` in production. Leaving `demo` in creates sixteen "Dummy" people.
- Node 22 in the image (sanitize-html needs 22.12 or later); the host's Node version is irrelevant since everything runs in Docker.
- A Teams recording's SharePoint sharing link plays in Cadence once the app registration saved under Settings > Sign-in holds the Microsoft Graph **application** permission `Files.Read.All`, with admin consent. Cadence then asks Graph which file the link points to and plays it through SharePoint's own player, the link Share > Embed gives; meetings saved earlier get theirs within the hour. Settings > Sign-in > SharePoint recordings says whether it works and, when it does not, Microsoft's reason. Without the permission a sharing link opens in SharePoint, as before.
- A Teams recording's transcript arrives on its own once the same app registration also holds the Microsoft Graph **application** permission `OnlineMeetingTranscript.Read.All` (with admin consent), a Teams application access policy grants the app (`New-CsApplicationAccessPolicy`, then `Grant-CsApplicationAccessPolicy -Global`), and Teams admin center > Meetings > Meeting settings > Transcript API access has Microsoft Graph access on (and speaker attribution, for names). Settings > Sign-in > Teams transcripts says whether it works and, when it does not, Microsoft's reason. The worker asks again each hour for recent meetings without one.
- Meeting recordings are **not** stored by Cadence: it keeps the link, the transcript text and any analysis. Playback streams from wherever the recording lives (SharePoint, Drive, your own file host), so viewers must be able to reach it and be signed in to Microsoft 365 or Google where that applies. Disk use stays tiny.
- Postgres is deliberately tuned small in `docker-compose.yml` (`shared_buffers=192MB`, `work_mem=8MB`, `jit=off`) and Prisma's pool is capped (`connection_limit=6` web, `4` worker). If you move to a bigger box, raise those rather than leaving the defaults: Prisma's default pool is `cores * 2 + 1`, which opens far more Postgres backends than this workload needs.

## Outreach sandbox, Bellwether and Twilio (November 2026)

New environment variables. Secrets go in the Nomad variable `nomad/jobs/cadence` (the templates in
`nomad/cadence.hcl` read them into both the web and the worker containers); locally they go in
`.env`. Names only here: never put a value in the repository, a doc or a chat.

| Variable | Secret | Set in | Needed by | What it does |
|---|---|---|---|---|
| `BELLWETHER_API_KEY` | yes | Nomad variable `nomad/jobs/cadence` | web | The key Bellwether sends as `X-Cadence-Api-Key`. At least 32 random bytes, base64url. The same value goes into Bellwether's `CADENCE_API_KEY`. Unset: every Bellwether call gets 503 `integration_disabled`. |
| `BELLWETHER_API_KEY_PREVIOUS` | yes | Nomad variable, during a rotation only | web | The old key, still accepted while Bellwether moves to the new one. Remove it afterwards. |
| `TWILIO_ACCOUNT_SID` | no (an id) | Nomad variable | web, worker | The Twilio account behind the hosted dialpad. |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | the secret is | Nomad variable | web, worker | A **Restricted** API key made for Cadence in the Twilio console, with read permission only on Calls, Recordings (including media) and IncomingPhoneNumbers. With any of the three Twilio variables unset the import is off and Settings > Calling says which is missing. |
| `GRAPH_MAIL_ENABLED` | no | the template (`GRAPH_MAIL_ENABLED=false` until the admin steps below are done) | web, worker | `true` turns on reading the sales mailboxes through Microsoft Graph. |
| `TWILIO_API_URL` | no | tests only | - | Points the Twilio client at a stand-in. Leave unset in production. |
| `CADENCE_FAKE_TWILIO` | no | tests only | - | `1` uses the in-memory Twilio. Refused in production unless mock mode is allowed. |

Existing variables the feature relies on: `TWENTY_API_KEY` (its role must allow creating People,
Companies and Notes, and deleting People and Companies for undo), `CADENCE_DRY_RUN` (still stops
every write to Twenty, Move to CRM included), `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` /
`MICROSOFT_CLIENT_SECRET` or the app saved in Settings > Sign-in (Graph mail uses the same app).

One-off steps before the pilot:

1. Apply the migration `20261103000000_outreach_sandbox` (the entrypoint runs `prisma migrate deploy`;
   every object is new or optional, so it is safe with the app running).
2. Create the Bellwether key and set it in both apps.
3. Create the Restricted Twilio API key, set the three Twilio variables, then in Settings > Calling
   confirm which rep owns each number.
4. For Graph mail, follow the admin steps in section 12 of `docs/outreach-sandbox-plan.md`
   (mail-enabled security group, `Mail.Read` application permission, `New-ApplicationAccessPolicy`,
   `Test-ApplicationAccessPolicy`), then set `GRAPH_MAIL_ENABLED=true`.
5. Leave Twenty's contact auto-creation from mail and calendars on. Apply the migration
   `20261103120000_sandbox_crm_cleanup` (three nullable columns, safe with the app running). The
   worker then removes, every 5 minutes, the people Twenty creates for sandbox contacts when nobody
   has worked them (plan section 8.9). It soft-deletes, so a removed person can be restored from
   Twenty's trash; `TWENTY_API_KEY` already may delete People for undo. Settings > Sandbox shows
   the count and has the switch. To watch it first, run with `CADENCE_DRY_RUN=true` and read the
   `crm_auto_person_would_remove` audit rows.
6. Apply the migration `20261104090000_sandbox_crm_check` (three nullable columns, safe with the app
   running). The worker's nightly run then checks every sandbox contact against Twenty (plan
   section 8.10) and logs `sandbox crm check` with the counts.


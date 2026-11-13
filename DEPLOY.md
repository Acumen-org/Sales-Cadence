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

- **Health check:** `GET /api/health` returns `{"ok":true,"db":"up","worker":"up"}`; `GET /api/health/worker` fails when the worker is stale.
- **Backup:** only Postgres holds state. With Compose: `docker compose exec db pg_dump -U cadence cadence | gzip > backup.sql.gz`, nightly. Production: the Nomad job in "Backups" below. Everything else is rebuildable from git.
- **Restart safety:** both processes are stateless; the worker's jobs are idempotent, so a restart mid-job is harmless.
- **Secrets:** `.env` only. `TWENTY_API_KEY` grants full CRM access, so keep the file `chmod 600`. Sessions are database tokens; there is no signing secret.
- **Lost admin password:** `docker compose exec web pnpm admin:password -- <email> <new password>` sets a new one and signs that account out everywhere.
- **Scaling:** one web container handles this workload comfortably. If it ever needs more, run several `web` containers behind the proxy; the worker must stay a **single** instance (it is the scheduler).

## Production on Nomad: emergency steps

Everything above under "Deploy" and "Running it" describes Docker Compose, which is how Cadence runs
on a single box. **Production does not run that way.** It runs as the Nomad job `cadence`
(`nomad/cadence.hcl`: a `web` and a `worker` task, pinned to `worker-5`), deployed by CI on every
push to `main`, with its secrets in the Nomad variable `nomad/jobs/cadence`. The database is
Postgres 18 on `db-acumen`. Every step below is written for that setup.

Commands assume `NOMAD_ADDR` and a `NOMAD_TOKEN` with rights on the job. To run a command inside
the app:

```bash
ALLOC=$(nomad job allocs -t '{{range .}}{{if eq .ClientStatus "running"}}{{.ID}}{{end}}{{end}}' cadence)
nomad alloc exec -task web "$ALLOC" pnpm sync:diagnose
nomad alloc logs -f -task worker "$ALLOC"          # or -task web; -stderr for errors
```

**Changing a Nomad variable item** (any key below): Nomad UI > Variables > `nomad/jobs/cadence` >
Edit, change the item, Save. Both tasks re-render their environment and restart within a minute.
From the CLI, `nomad var get -out=json nomad/jobs/cadence > v.json`, edit, then
`nomad var put -force @v.json` and delete `v.json`: it holds every secret. `nomad var put` with
only `KEY=value` arguments replaces the whole variable, dropping every other item.

### Health

- `GET /api/health`: 200 while the database answers; the body also says `"worker":"up"` or `"stale"`.
- `GET /api/health/worker`: 503 when the worker has not started a pass for 20 minutes. Nomad checks
  it on the worker task and restarts the worker after three failures (service `cadence-worker`).

### Stop all CRM writes

1. Set the item `CADENCE_DRY_RUN` to `true` in `nomad/jobs/cadence`. Both tasks restart in dry run:
   reads, webhooks and the screens work; every write to Twenty (notes, tasks, opt-out flags, moves,
   meetings) is only logged. Settings shows "Dry run".
2. Faster and blunter, when Twenty must stop hearing from Cadence at once: delete Cadence's API key
   in Twenty (Settings > APIs & Webhooks). Reads stop too; the sync shows errors until a new key is set.
3. To resume: set `CADENCE_DRY_RUN` to `false` (or remove it). Writes refused while Twenty was
   unreachable wait in Settings > Activity log > Writes to Twenty, to retry or discard.

### Roll back a release

Migrations are additive, so the previous image runs on the newer schema. Never undo a migration
by hand.

1. A release that never passes its health checks rolls itself back (`auto_revert`). Check with
   `nomad job status cadence` and `nomad job history -p cadence`.
2. To go back by hand: `nomad job history cadence` lists versions with their `image_tag`, then
   `nomad job revert cadence <version>`. Or, from a checkout of the commit to return to:
   `nomad job run -var="image_tag=prod-v1.0.0-<7-char sha>" nomad/cadence.hcl`.
3. Push a revert commit to `main` as well, or the next CI run deploys the bad release again.

### A failed migration

Each start runs `prisma migrate deploy`. If a migration fails or is cut off part-way (killed, out of
memory, two deploys at once), Prisma records it as failed and applies nothing more until someone
resolves it. The web log then says `FATAL: migration <name> failed`. The previous image (auto_revert)
still starts: it does not carry that migration and starts without migrating. Nothing newer can
deploy until the migration is resolved.

1. Find the migration: the web task's log, or
   `nomad alloc exec -task web "$ALLOC" pnpm exec prisma migrate status`.
2. Read `prisma/migrations/<name>/migration.sql` and check in `psql` which of its objects exist.
3. Resolve it, from the running (older) web task or any machine with `DATABASE_URL` and a checkout
   of the release that carries the migration:
   - nothing or part of it applied (our migrations use `IF NOT EXISTS`, so they can run again):
     `pnpm exec prisma migrate resolve --rolled-back <name>`, fix the cause, deploy again. The
     deploy runs it again.
   - all of it applied (the process died after the SQL finished):
     `pnpm exec prisma migrate resolve --applied <name>`.
4. Redeploy: re-run the CI deploy, or `nomad job run -var="image_tag=<tag>" nomad/cadence.hcl`.

### Backups

`nomad/cadence-backup.hcl` is a periodic Nomad job (03:30 New York time) that runs
`scripts/backup-db.sh`: a `pg_dump` in custom format, kept only if `pg_restore` can list its table
data, written to `cadence-<UTC time>.dump` in the directory given as `backup_host_path`, with dumps
older than `retention_days` (14) deleted. Set up once, from the repository root:

```bash
nomad var put nomad/jobs/cadence-db-backup DATABASE_URL='postgresql://<read-only role>:<pw>@<host>:5432/<db>'
nomad job run -var="backup_host_path=/srv/backups/cadence" nomad/cadence-backup.hcl
nomad job periodic force cadence-db-backup     # one now, then check the directory and the log
```

The directory must be storage that does not die with the database server (a backup share, NFS),
and the Nomad client must allow docker volume mounts. A failed run shows as a failed allocation of
`cadence-db-backup` in Nomad.

### Restore the database

Test a restore once a month into a scratch database (steps 2 and 3 only, with a new database name)
and note the date and the dump used here: a backup that has never been restored is a hope.

1. Stop everything that writes: `nomad job stop cadence`. Do not force a backup while restoring.
2. Pick the dump (`ls -lt <backup dir>`), and restore from a Postgres 18 container that can reach
   the server:
   ```bash
   docker run --rm -it -v /srv/backups/cadence:/backups postgres:18-alpine \
     pg_restore --clean --if-exists --no-owner --no-privileges \
       --dbname='postgresql://<owner role>:<pw>@<host>:5432/<db>' /backups/cadence-<stamp>.dump
   ```
   Safer when the old database may still be needed: create a new database, restore into it, then
   point `DATABASE_URL` in `nomad/jobs/cadence` at it.
3. Check: `psql ... -c 'select count(*) from "Enrollment"'` and the newest `"AuditLog"."createdAt"`.
4. Start: `nomad job run -var="image_tag=<the tag that was running>" nomad/cadence.hcl`. The
   entrypoint applies any migration newer than the dump.
5. Catch up with the CRM for the time since the dump:
   `nomad alloc exec -task web "$ALLOC" pnpm reconcile <days since the dump + 1>`, then
   Settings > Twenty > Full refresh. Work done in Cadence after the dump (completed steps, notes,
   meetings) is lost; what reached Twenty comes back through the reconcile.

### Rotate a key

Change one key at a time, check, then revoke the old one.

| Key | Where it lives | Rotate |
|---|---|---|
| Twenty API key | `TWENTY_API_KEY` in `nomad/jobs/cadence` | Twenty > Settings > APIs & Webhooks: create a key with the same role. Set it, wait for the restart, check Settings > Twenty shows connected and the next sync passes. Delete the old key in Twenty. |
| Twenty webhook secret | `TWENTY_WEBHOOK_SECRET`, and the webhook in Twenty | Change both within a minute. Events in between are refused; run `pnpm reconcile 1` afterwards to pick them up. |
| Twilio | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Twilio console > API keys: create a Restricted key with the same read permissions. Set both items, check Settings > Calling, delete the old key. |
| Microsoft app secret | Settings > Sign-in (database), or `MICROSOFT_CLIENT_SECRET` where set | Entra admin center > App registrations > Cadence > Certificates & secrets: new secret. Save it in Settings > Sign-in, sign in from a private window, delete the old secret. If it already expired and nobody can sign in, see "Admin locked out". |
| Bellwether key | `BELLWETHER_API_KEY` (+ `_PREVIOUS`) | As in the Bellwether table below: new key in, old one in `BELLWETHER_API_KEY_PREVIOUS`, Bellwether moved over, then the previous one removed. |
| Database password | `DATABASE_URL` in `nomad/jobs/cadence` (and `nomad/jobs/cadence-db-backup` for its role) | `ALTER ROLE <role> PASSWORD '<new>'` and update the variable immediately after: connections fail between the two. |
| Registry (Harbor) | the Nomad client's Docker auth on worker-5; GitHub secrets `HARBOR_USERNAME`/`HARBOR_PASSWORD` (CI push) | Harbor > project `sales-cadence` > Robot accounts: refresh the secret of the pull robot, update the client's Docker auth file; refresh the push robot, update the GitHub secrets. The job itself holds no registry credentials. |
| Nomad deploy token | GitHub secret `NOMAD_TOKEN` | `nomad acl token create -name=github-cadence-deploy -policy=<the deploy policy>`, put the secret ID in GitHub, run a deploy, then `nomad acl token delete <old accessor ID>`. |

### Registry credentials

The job does not carry registry credentials (anyone who can read a Nomad job, or its old versions,
could read them). Images are pulled with the Nomad client's own Docker auth on `worker-5`: a Harbor
**robot account** with pull rights on `sales-cadence` only, in the client configuration:

```hcl
plugin "docker" {
  config {
    auth { config = "/etc/nomad.d/docker-auth.json" }   # {"auths":{"h4rb0r.pmx.acumen-strategy.com":{"auth":"<base64 robot:secret>"}}}
  }
}
```

Restart the Nomad client after changing it. CI's push to Harbor uses the GitHub secrets.

### Admin locked out

- Lost password: `nomad alloc exec -task web "$ALLOC" pnpm admin:password -- <email> '<new password>'`.
  It signs that account out everywhere.
- No admin account left (removed, or nobody knows which): set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in
  `nomad/jobs/cadence` to a new address and a strong password. The web restarts and the seed creates
  that account as an admin (it only ever creates an account that does not exist).
- Microsoft sign-in broken (an expired secret, usually): set `PASSWORD_SIGN_IN=true` in
  `nomad/jobs/cadence`, sign in with a password, fix Settings > Sign-in, then remove the item.

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


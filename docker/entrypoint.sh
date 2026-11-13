#!/bin/sh
# Usage: entrypoint.sh web|worker
set -e
ROLE="${1:-web}"

# T01: a migration that failed (or was cut off part-way) makes Prisma refuse every later
# `migrate deploy`. Two cases, told apart by whether this image carries the failed migration:
#  - it does: nothing can start until someone resolves it. Say so plainly and stop, rather than
#    retrying for 90 seconds under "database not ready".
#  - it does not (an older image, started by auto_revert after a newer release's migration
#    failed): migrations are additive, so this image runs on the schema as it is. It starts
#    without migrating, which is what lets the roll-back succeed.
# Recovery: DEPLOY.md, "A failed migration".
# T37: both tasks run this; Prisma's advisory lock lets one apply the migrations while the other
# waits (T38: that wait is not counted as the database being unreachable).
echo "[cadence] applying database migrations..."
n=0
waited=0
while :; do
  if out=$(pnpm exec prisma migrate deploy 2>&1); then
    echo "$out"
    break
  fi
  echo "$out"
  case "$out" in
    *P3009*|*P3018*|*"failed migrations"*)
      failed=$(printf '%s\n' "$out" | sed -n 's/.*The `\([^`]*\)` migration.*/\1/p' | head -n 1)
      if [ -n "$failed" ] && [ ! -d "prisma/migrations/$failed" ]; then
        echo "[cadence] migration $failed, from a newer release, failed in this database. This image does not need it and starts without migrating."
        echo "[cadence] Resolve it before deploying that release again: DEPLOY.md, 'A failed migration'."
        break
      fi
      echo "[cadence] FATAL: migration ${failed:-(see above)} failed; Prisma applies nothing until it is resolved, so Cadence cannot start."
      echo "[cadence] Recovery: DEPLOY.md, 'A failed migration' (prisma migrate resolve)."
      exit 1
      ;;
    *"advisory lock"*)
      # The other task (or another start) is applying migrations: wait for it, up to 20 minutes.
      waited=$((waited+1))
      if [ "$waited" -ge 120 ]; then echo "[cadence] another start held the migration lock for 20 minutes, giving up"; exit 1; fi
      echo "[cadence] another start is applying migrations; waiting ($waited)"
      continue
      ;;
    *P1000*|*P1001*|*P1002*|*P1017*|*"Can't reach database"*)
      reason="database not reachable"
      ;;
    *)
      reason="migrate deploy failed (see the error above; not a connection problem)"
      ;;
  esac
  n=$((n+1))
  if [ "$n" -ge 30 ]; then echo "[cadence] $reason, giving up after 30 tries"; exit 1; fi
  echo "[cadence] $reason, retrying in 3s ($n/30)"
  sleep 3
done

if [ "$ROLE" = "web" ]; then
  if [ "${SEED_ON_START:-true}" = "true" ]; then
    echo "[cadence] seeding (profile: ${SEED_PROFILE:-core})..."
    # T23: a failed seed is reported, not a reason to keep the web app down.
    node --import tsx prisma/seed.ts || echo "[cadence] WARNING: the seed failed (see above); starting anyway"
  fi
  echo "[cadence] starting web on :3000"
  exec node node_modules/next/dist/bin/next start -p 3000
elif [ "$ROLE" = "worker" ]; then
  echo "[cadence] starting worker"
  # T10: node itself, no pnpm or tsx wrapper in between, so the stop signal reaches the worker.
  exec node --import tsx src/worker/index.ts
else
  echo "unknown role: $ROLE"; exit 1
fi

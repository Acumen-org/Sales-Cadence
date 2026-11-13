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
echo "[cadence] applying database migrations..."
n=0
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
  esac
  n=$((n+1))
  if [ "$n" -ge 30 ]; then echo "[cadence] database not reachable, giving up"; exit 1; fi
  echo "[cadence] database not ready, retrying in 3s ($n/30)"
  sleep 3
done

if [ "$ROLE" = "web" ]; then
  if [ "${SEED_ON_START:-true}" = "true" ]; then
    echo "[cadence] seeding (profile: ${SEED_PROFILE:-core})..."
    pnpm exec tsx prisma/seed.ts
  fi
  echo "[cadence] starting web on :3000"
  exec pnpm exec next start -p 3000
elif [ "$ROLE" = "worker" ]; then
  echo "[cadence] starting worker"
  exec pnpm exec tsx src/worker/index.ts
else
  echo "unknown role: $ROLE"; exit 1
fi

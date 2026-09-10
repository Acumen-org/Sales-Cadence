#!/bin/sh
# Usage: entrypoint.sh web|worker
set -e
ROLE="${1:-web}"

echo "[cadence] applying database migrations..."
n=0
until pnpm exec prisma migrate deploy; do
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

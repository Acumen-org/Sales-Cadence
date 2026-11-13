#!/bin/sh
# T02: one backup of Cadence's Postgres database, checked, with old copies removed.
#
#   DATABASE_URL            postgresql://user:pass@host:port/db (no ?query part)
#   BACKUP_DIR              where the dumps go (default /backups); mount the real destination here
#   BACKUP_RETENTION_DAYS   dumps older than this are deleted (default 14)
#
# Writes cadence-<UTC time>.dump in pg_dump's custom format (compressed, restorable with
# pg_restore, table by table if need be), first under a .partial name, and keeps it only if
# pg_restore can read its table of contents. Run by the periodic Nomad job nomad/cadence-backup.hcl;
# the restore is in DEPLOY.md, "Restore the database".
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/cadence-$stamp.dump"
partial="$final.partial"

echo "[backup] dumping to $final"
pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$partial"
# A dump that cannot be listed cannot be restored: fail loudly rather than keep it.
tables=$(pg_restore --list "$partial" | grep -c ' TABLE DATA ' || true)
if [ "$tables" -lt 1 ]; then
  echo "[backup] FAILED: the dump holds no table data" >&2
  rm -f "$partial"
  exit 1
fi
mv "$partial" "$final"
echo "[backup] ok: $(du -h "$final" | cut -f1), $tables tables"

# Retention: only this job's own files, and never the one just written.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cadence-*.dump' -mtime "+$RETENTION" ! -name "$(basename "$final")" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cadence-*.dump.partial' -mtime +1 -print -delete

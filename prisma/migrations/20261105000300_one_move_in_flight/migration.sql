-- One move in flight per cold contact (PLAN 8.6 and 8.12, B005): a second Move to CRM of a contact
-- whose first is still queued or running is refused by the database, so two tabs or a re-queue can
-- no longer make two CRM people. Duplicates already queued are settled first (PLAN 9.7 step 3): the
-- newest item per contact is kept, every older one ends FAILED as a permanent failure (so Retry
-- leaves it alone) and gets an audit row (deduped_by_migration) naming the move, any CRM person it
-- had already created, and the item kept. Nothing is deleted. The table is locked for these few
-- statements, so the index cannot fail. Running this again finds nothing and changes nothing.
LOCK TABLE "SandboxMoveItem" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
  settled integer := 0;
  moves text[] := ARRAY[]::text[];
  r record;
BEGIN
  FOR r IN
    SELECT i."id", i."moveId", i."sandboxContactId", i."state", i."mode", i."twentyPersonId", i."twentyCompanyId", ranked."keptId"
    FROM "SandboxMoveItem" i
    JOIN (
      SELECT x."id", first_value(x."id") OVER w AS "keptId", row_number() OVER w AS rank
      FROM "SandboxMoveItem" x JOIN "SandboxMove" m ON m."id" = x."moveId"
      WHERE x."state" IN ('QUEUED', 'RUNNING')
      WINDOW w AS (PARTITION BY x."sandboxContactId" ORDER BY m."createdAt" DESC, x."id" DESC)
    ) ranked ON ranked."id" = i."id"
    WHERE ranked.rank > 1
    ORDER BY i."sandboxContactId", i."id"
  LOOP
    UPDATE "SandboxMoveItem" SET "state" = 'FAILED', "failure" = 'permanent', "claimedAt" = NULL,
      "error" = 'Not moved: the same contact was queued again, and the later move is the one that runs.'
    WHERE "id" = r."id";
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'sandbox_move', r."moveId", 'deduped_by_migration', 'SYSTEM', 'Cadence (release migration)',
            jsonb_build_object('migration', '20261105000300_one_move_in_flight', 'itemId', r."id", 'sandboxContactId', r."sandboxContactId",
                               'was', r."state", 'mode', r."mode", 'twentyPersonId', r."twentyPersonId", 'twentyCompanyId', r."twentyCompanyId",
                               'kept', r."keptId"),
            stamp);
    settled := settled + 1;
    moves := array_append(moves, r."moveId");
  END LOOP;
  -- A move none of whose items waits or runs any more is finished, as finishMoveIfSettled says.
  UPDATE "SandboxMove" m SET "state" = 'DONE', "finishedAt" = stamp
  WHERE m."id" = ANY(moves) AND m."state" <> 'DONE'
    AND NOT EXISTS (SELECT 1 FROM "SandboxMoveItem" i WHERE i."moveId" = m."id" AND i."state" IN ('QUEUED', 'RUNNING'));
  IF settled > 0 THEN
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'settings', 'migrations', 'deduped_by_migration', 'SYSTEM', 'Cadence (release migration)',
            jsonb_build_object('migration', '20261105000300_one_move_in_flight', 'moveItemsFailed', settled), stamp);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "SandboxMoveItem_one_in_flight_per_contact" ON "SandboxMoveItem"("sandboxContactId") WHERE "state" IN ('QUEUED', 'RUNNING');

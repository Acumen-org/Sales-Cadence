-- One open next step per cold contact (PLAN 8.12, B005, B009), the twin of
-- NextAction_one_open_per_person. Setting a next step looked for an open one and then created one,
-- so two requests at once could leave two. Those duplicates are closed first (PLAN 9.7 step 2): the
-- newest per contact is kept, every other is CANCELLED, never deleted, and each gets an audit row
-- (deduped_by_migration) with what it said, so it can be put back. The table is locked for these
-- few statements, so no write can add a duplicate between the clean-up and the index, and the
-- index cannot fail. Running this again finds nothing to close and leaves the index as it is.
LOCK TABLE "NextAction" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
  closed integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT n."id", n."sandboxContactId", n."label", n."action", n."dueDate", n."foUserId", n."createdAt", ranked."keptId"
    FROM "NextAction" n
    JOIN (
      SELECT "id", first_value("id") OVER w AS "keptId", row_number() OVER w AS rank
      FROM "NextAction" WHERE "state" = 'OPEN' AND "personId" IS NULL AND "sandboxContactId" IS NOT NULL
      WINDOW w AS (PARTITION BY "sandboxContactId" ORDER BY "createdAt" DESC, "id" DESC)
    ) ranked ON ranked."id" = n."id"
    WHERE ranked.rank > 1
    ORDER BY n."sandboxContactId", n."createdAt"
  LOOP
    UPDATE "NextAction" SET "state" = 'CANCELLED', "closedAt" = stamp, "updatedAt" = stamp WHERE "id" = r."id";
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'sandbox_contact', r."sandboxContactId", 'deduped_by_migration', 'SYSTEM', 'Cadence (release migration)',
            jsonb_build_object('migration', '20261105000200_one_open_cold_next_action', 'nextActionId', r."id", 'kept', r."keptId",
                               'label', r."label", 'action', r."action", 'dueDate', r."dueDate", 'foUserId', r."foUserId",
                               'createdAt', r."createdAt", 'was', 'OPEN'),
            stamp);
    closed := closed + 1;
  END LOOP;
  IF closed > 0 THEN
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'settings', 'migrations', 'deduped_by_migration', 'SYSTEM', 'Cadence (release migration)',
            jsonb_build_object('migration', '20261105000200_one_open_cold_next_action', 'nextActionsClosed', closed), stamp);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "NextAction_one_open_per_sandbox_contact" ON "NextAction"("sandboxContactId") WHERE "state" = 'OPEN' AND "personId" IS NULL;

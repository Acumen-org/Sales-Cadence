-- W14 (cold outreach PLAN 8.12 M3, B050): the CHECK that an owned cold contact has a pod is validated,
-- so it holds for every row, old ones included. 20261105200000 added it NOT VALID after putting the
-- rows of the time right, and it has checked every write since. Before validating, any row that would
-- fail is put right again the same way, each audited with what it was, so the validation cannot fail:
--   * an owner in a pod: the owner's first pod by name (pod_set_by_migration);
--   * an owner in no pod (an admin or Biz Ops, who never own cold contacts): the contact is let go,
--     unclaimed, and the audit row names who held it (released_by_migration).
-- The table is locked against writes for these statements. Deterministic and idempotent: a second
-- run finds nothing to put right, and validating a valid CHECK changes nothing.
LOCK TABLE "SandboxContact" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH fix AS (
    SELECT c."id", c."ownerId", (
      SELECT up."podId" FROM "UserPod" up JOIN "Pod" p ON p."id" = up."podId"
      WHERE up."userId" = c."ownerId" ORDER BY p."archived", p."name", p."id" LIMIT 1
    ) AS "podId"
    FROM "SandboxContact" c WHERE c."ownerId" IS NOT NULL AND c."podId" IS NULL
  ), done AS (
    UPDATE "SandboxContact" s SET "podId" = fix."podId" FROM fix WHERE s."id" = fix."id" AND fix."podId" IS NOT NULL
    RETURNING s."id", fix."ownerId", fix."podId"
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', done."id", 'pod_set_by_migration', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261106300100_owned_contact_has_pod_validated', 'ownerId', done."ownerId", 'podId', done."podId"), stamp
  FROM done;

  WITH old AS (
    SELECT c."id", c."ownerId", c."claimedAt" FROM "SandboxContact" c WHERE c."ownerId" IS NOT NULL AND c."podId" IS NULL
  ), done AS (
    UPDATE "SandboxContact" s SET "ownerId" = NULL, "claimedAt" = NULL FROM old WHERE s."id" = old."id"
    RETURNING s."id", old."ownerId", old."claimedAt"
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', done."id", 'released_by_migration', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261106300100_owned_contact_has_pod_validated', 'from', done."ownerId", 'claimedAt', done."claimedAt",
      'reason', 'Its owner is in no pod (an admin or Biz Ops), and an owned contact always has a pod (B050).'), stamp
  FROM done;
END $$;

-- Added here too when an environment never had it, so the validation always has its CHECK.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SandboxContact_owner_has_pod') THEN
    ALTER TABLE "SandboxContact" ADD CONSTRAINT "SandboxContact_owner_has_pod" CHECK ("ownerId" IS NULL OR "podId" IS NOT NULL) NOT VALID;
  END IF;
END $$;
ALTER TABLE "SandboxContact" VALIDATE CONSTRAINT "SandboxContact_owner_has_pod";

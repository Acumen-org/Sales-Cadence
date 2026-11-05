-- M2 (cold outreach PLAN 8.12, B050): an owned cold contact always has a pod. Every path that sets an
-- owner now goes through the transfer rules (src/lib/outreach/transfer.ts), which never leave the pod
-- empty, so the rule can hold in the database. First the rows from before it are put right, each one
-- audited with what it was, so nothing is lost:
--   * an owner in a pod: the owner's first pod by name (an owner in exactly one pod was filled by
--     20261105000001; this covers owners in several pods, and contacts that are no longer ACTIVE);
--   * an owner in no pod (an admin or Biz Ops, who never own cold contacts): the contact is let go,
--     unclaimed, and the audit row names who held it.
-- Then the CHECK, NOT VALID (validated in W14): nothing is left for it to skip after the fix above,
-- and it checks every write from now on. Deterministic and idempotent: a second run changes nothing.
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
    jsonb_build_object('migration', '20261105200000_owned_contact_has_pod', 'ownerId', done."ownerId", 'podId', done."podId"), stamp
  FROM done;

  WITH old AS (
    SELECT c."id", c."ownerId", c."claimedAt" FROM "SandboxContact" c WHERE c."ownerId" IS NOT NULL AND c."podId" IS NULL
  ), done AS (
    UPDATE "SandboxContact" s SET "ownerId" = NULL, "claimedAt" = NULL FROM old WHERE s."id" = old."id"
    RETURNING s."id", old."ownerId", old."claimedAt"
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', done."id", 'released_by_migration', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261105200000_owned_contact_has_pod', 'from', done."ownerId", 'claimedAt', done."claimedAt",
      'reason', 'Its owner is in no pod (an admin or Biz Ops), and an owned contact always has a pod (B050).'), stamp
  FROM done;
END $$;

ALTER TABLE "SandboxContact" DROP CONSTRAINT IF EXISTS "SandboxContact_owner_has_pod";
ALTER TABLE "SandboxContact" ADD CONSTRAINT "SandboxContact_owner_has_pod" CHECK ("ownerId" IS NULL OR "podId" IS NOT NULL) NOT VALID;

-- S9 (cold outreach PLAN 7.3, W11): contract v1.1 between Bellwether and Cadence. Additive only.
--
-- BellwetherRefusal.reason: every push refusal is kept (B015), and one that is not already in the
-- CRM or opted out is reported as status "refused" with this reason. Rows from before keep NULL.
-- SandboxContact.possibleDuplicateId: an active contact a push may have doubled (B017).
-- SandboxContact.erasedAt: when an admin erased the contact (N039); Bellwether reads it as erasedAt.
--
-- erasedAt is filled for contacts erased before this release from their "erased" audit row (the
-- latest one). Deterministic and idempotent: a contact with erasedAt set is left alone. Audited per
-- contact.
ALTER TABLE "BellwetherRefusal" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "SandboxContact" ADD COLUMN IF NOT EXISTS "possibleDuplicateId" TEXT;
ALTER TABLE "SandboxContact" ADD COLUMN IF NOT EXISTS "erasedAt" TIMESTAMP(3);

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH erased AS (
    SELECT "entityId" AS id, MAX("createdAt") AS at FROM "AuditLog"
    WHERE "entityType" = 'sandbox_contact' AND "action" = 'erased'
    GROUP BY "entityId"
  ), filled AS (
    UPDATE "SandboxContact" s SET "erasedAt" = erased.at
    FROM erased
    WHERE s."id" = erased.id AND s."erasedAt" IS NULL
    RETURNING s."id", s."erasedAt"
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', filled."id", 'erased_at_backfill', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261106100000_contract_v1_1', 'erasedAt', filled."erasedAt"), stamp
  FROM filled;
END $$;

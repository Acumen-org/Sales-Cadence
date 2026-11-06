-- S6 (cold outreach PLAN 6 rule 2, 8.14): one email counts once in All outreach.
--
-- An "Also in CRM" cold contact emailed from Outlook was recorded twice: as the contact's own cold
-- touch (Outlook tracking), and as a touch on the real CRM person (the CRM's mail sync). Before a move
-- the work is cold, so the cold touch is the one that counts; the CRM's record of the same email
-- stays on the person's timeline and is marked as its copy, which every figure leaves out.
-- Additive: a nullable column and its index.
ALTER TABLE "Touch" ADD COLUMN "copyOfTouchId" TEXT;
CREATE INDEX "Touch_copyOfTouchId_idx" ON "Touch"("copyOfTouchId");

-- The copies already written since 3 Nov: a CRM email touch on a person a cold contact points to
-- (its CRM match, the person the mail sync made for it, or the person it moved to), with a cold
-- email touch of that contact in the same direction, within ten minutes, under the same summary.
-- Each is linked to the nearest such cold touch and audited. Idempotent: a linked touch is skipped.
DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH pairs AS (
    SELECT DISTINCT ON (crm."id") crm."id" AS crm_id, cold."id" AS cold_id, sc."id" AS contact_id
    FROM "Touch" crm
    JOIN "SandboxContact" sc ON crm."personId" IN (sc."crmMatchPersonId", sc."crmAutoPersonId", sc."twentyPersonId")
    JOIN "Touch" cold ON cold."sandboxContactId" = sc."id"
    WHERE crm."sandboxContactId" IS NULL AND crm."audience" = 'CRM' AND crm."channel" = 'EMAIL' AND crm."copyOfTouchId" IS NULL
      AND cold."audience" = 'SANDBOX' AND cold."channel" = 'EMAIL' AND cold."direction" = crm."direction" AND cold."copyOfTouchId" IS NULL
      AND abs(extract(epoch FROM (cold."occurredAt" - crm."occurredAt"))) <= 600
      AND lower(btrim(cold."summary")) = lower(btrim(crm."summary"))
    ORDER BY crm."id", abs(extract(epoch FROM (cold."occurredAt" - crm."occurredAt"))), cold."id"
  ), linked AS (
    UPDATE "Touch" t SET "copyOfTouchId" = pairs.cold_id
    FROM pairs WHERE t."id" = pairs.crm_id AND t."copyOfTouchId" IS NULL
    RETURNING t."id", t."personId", pairs.cold_id, pairs.contact_id
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'person', linked."personId", 'email_counted_once', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261105500000_touch_counted_once', 'touchId', linked."id", 'countedAs', linked.cold_id, 'sandboxContactId', linked.contact_id), stamp
  FROM linked;
END $$;

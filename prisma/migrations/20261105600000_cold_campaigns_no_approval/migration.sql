-- S7 (cold outreach W7, owner's decision of 5 Nov 2026): cold campaigns need no approval, the same as
-- CRM campaigns. Publishing one in the campaign studio schedules it and tells its pod's leaders.
--
-- What this does to a cold campaign (audience SANDBOX) in each state:
--   * PENDING_APPROVAL (made with the old "Start campaign" form, waiting for a leader since 3 Nov):
--     back to DRAFT, with its approval fields cleared. Nothing was ever sent for it, and nothing is
--     sent until someone publishes it in the studio, where every new check runs (the cold audience
--     check, Do not contact, the start date, who runs it). Its creator is told in the bell; when the
--     creator no longer has access, its pod's Sales Leaders and Pod Managers are. Each is audited
--     (approval_removed) with what it was, so nothing is lost. A draft can be opened, published or
--     deleted from its page, so none is left stuck.
--   * DRAFT, SCHEDULED, ACTIVE, PAUSED, STOPPED and COMPLETED: unchanged. A scheduled or running one
--     from before the studio starts and runs on its old pacing with launch's new re-checks
--     (src/lib/sandbox/campaigns.ts activateSandboxCampaign) until it ends (PLAN 9.7 step 14).
--
-- Then a CHECK keeps every cold campaign out of PENDING_APPROVAL from now on. The table is locked for
-- these few statements, so nothing can be written between the clean-up and the CHECK, and the CHECK
-- cannot fail. Deterministic and idempotent: a second run finds nothing waiting and changes nothing.
LOCK TABLE "Campaign" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH waiting AS (
    SELECT c."id", c."name", c."podId", c."createdById", c."startDate", cardinality(c."personIds") AS people, c."approvedAt", c."approvedById"
    FROM "Campaign" c WHERE c."audience" = 'SANDBOX' AND c."status" = 'PENDING_APPROVAL'
  ), done AS (
    UPDATE "Campaign" c SET "status" = 'DRAFT', "approvedAt" = NULL, "approvedById" = NULL, "updatedAt" = stamp
    FROM waiting WHERE c."id" = waiting."id" AND c."status" = 'PENDING_APPROVAL'
    RETURNING c."id", waiting."name", waiting."podId", waiting."createdById", waiting."startDate", waiting.people, waiting."approvedAt", waiting."approvedById"
  ), audited AS (
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    SELECT gen_random_uuid()::text, 'campaign', done."id", 'approval_removed', 'SYSTEM', 'Cadence (release migration)',
      jsonb_build_object('migration', '20261105600000_cold_campaigns_no_approval', 'from', 'PENDING_APPROVAL', 'to', 'DRAFT',
        'startDate', done."startDate", 'people', done.people, 'approvedAt', done."approvedAt", 'approvedById', done."approvedById"), stamp
    FROM done
    RETURNING 1
  )
  INSERT INTO "Notification" ("id", "userId", "kind", "payload", "createdAt")
  SELECT gen_random_uuid()::text, told."userId", 'campaign_back_to_draft', jsonb_build_object('campaignId', done."id", 'name', done."name"), stamp
  FROM done
  JOIN LATERAL (
    SELECT u."id" AS "userId" FROM "User" u WHERE u."id" = done."createdById" AND u."active"
    UNION
    SELECT u."id" FROM "User" u JOIN "UserPod" up ON up."userId" = u."id"
    WHERE up."podId" = done."podId" AND u."active" AND u."role" IN ('SALES_LEADER', 'POD_MANAGER')
      AND NOT EXISTS (SELECT 1 FROM "User" creator WHERE creator."id" = done."createdById" AND creator."active")
  ) told ON true;
END $$;

ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_cold_needs_no_approval";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_cold_needs_no_approval" CHECK ("audience" <> 'SANDBOX' OR "status" <> 'PENDING_APPROVAL');

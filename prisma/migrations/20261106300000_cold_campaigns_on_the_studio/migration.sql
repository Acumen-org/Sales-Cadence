-- W14 (cold outreach PLAN 9.7 step 14, 9.8): no cold campaign is left from before the campaign studio.
-- Cold campaigns made with the old "Start campaign" form have no studio plan (plannerDraft), so they
-- needed a launcher and a page of their own. This puts each one on the studio's footing, so the one
-- launcher and the one campaign page serve every cold campaign, and the old ones can be deleted:
--
--   * Not started (SCHEDULED, or ACTIVE or PAUSED with nobody ever enrolled): back to DRAFT, its
--     approval cleared. Nothing was ever sent for it, and nothing is sent until someone publishes it
--     in the studio, where every check of today runs (who may be in it, Do not contact, the start date,
--     who runs it). Its creator is told in the bell; when the creator no longer has access, the pod's
--     Sales Leaders and Pod Managers are. Audited (back_to_draft) with what it was.
--   * Every pre-studio cold campaign, whatever its state, then gets the plan the studio would open it
--     with: its own name, pod, dates and people, one "Default" outreach group with its sequence's
--     steps, and as its team the reps already running it. A campaign that is running carries on
--     exactly as it was: its contacts' steps follow their own enrollments, which this does not touch.
--     Audited (studio_plan_added) per campaign, so the plan can be taken off again by setting
--     plannerDraft back to null.
--
-- The campaign table is locked for these few statements, so no launch can start one of them in
-- between. Deterministic and idempotent: a second run finds no campaign without a plan.
LOCK TABLE "Campaign" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH waiting AS (
    SELECT c."id", c."name", c."podId", c."createdById", c."status", c."startDate", cardinality(c."personIds") AS people, c."approvedAt", c."approvedById"
    FROM "Campaign" c
    WHERE c."audience" = 'SANDBOX' AND c."plannerDraft" IS NULL AND c."status" IN ('SCHEDULED', 'ACTIVE', 'PAUSED')
      AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."campaignId" = c."id")
  ), done AS (
    UPDATE "Campaign" c SET "status" = 'DRAFT', "approvedAt" = NULL, "approvedById" = NULL, "updatedAt" = stamp
    FROM waiting WHERE c."id" = waiting."id"
    RETURNING c."id", waiting."name", waiting."podId", waiting."createdById", waiting."status", waiting."startDate", waiting.people, waiting."approvedAt", waiting."approvedById"
  ), audited AS (
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    SELECT gen_random_uuid()::text, 'campaign', done."id", 'back_to_draft', 'SYSTEM', 'Cadence (release migration)',
      jsonb_build_object('migration', '20261106300000_cold_campaigns_on_the_studio', 'from', done."status", 'to', 'DRAFT',
        'startDate', done."startDate", 'people', done.people, 'approvedAt', done."approvedAt", 'approvedById', done."approvedById",
        'why', 'Made before the campaign studio and not started'), stamp
    FROM done
    RETURNING 1
  )
  INSERT INTO "Notification" ("id", "userId", "kind", "payload", "createdAt")
  SELECT gen_random_uuid()::text, told."userId", 'campaign_back_to_draft', jsonb_build_object('campaignId', done."id", 'name', done."name", 'why', 'pre_studio'), stamp
  FROM done
  JOIN LATERAL (
    SELECT u."id" AS "userId" FROM "User" u WHERE u."id" = done."createdById" AND u."active"
    UNION
    SELECT u."id" FROM "User" u JOIN "UserPod" up ON up."userId" = u."id"
    WHERE up."podId" = done."podId" AND u."active" AND u."role" IN ('SALES_LEADER', 'POD_MANAGER')
      AND NOT EXISTS (SELECT 1 FROM "User" creator WHERE creator."id" = done."createdById" AND creator."active")
  ) told ON true;

  WITH old AS (
    SELECT c."id", c."status", c."personIds", c."startsPerFoPerDay", jsonb_build_object(
      'name', c."name", 'podId', c."podId", 'startDate', c."startDate",
      'endDate', COALESCE(c."endDate", (c."startDate"::date + 42)::text),
      'productInterest', to_jsonb(c."productInterest"),
      'defaultBatchSize', LEAST(500, GREATEST(1, COALESCE(c."startsPerFoPerDay", 20))),
      'fos', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', f."foUserId", 'batchSize', LEAST(500, GREATEST(1, COALESCE(c."startsPerFoPerDay", 20)))) ORDER BY f."foUserId")
        FROM (SELECT DISTINCT e."foUserId" FROM "Enrollment" e WHERE e."campaignId" = c."id") f
      ), '[]'::jsonb),
      'personIds', to_jsonb(c."personIds"),
      'assignments', '{}'::jsonb,
      'flows', jsonb_build_array(jsonb_build_object('id', 'default', 'name', 'Default', 'steps', COALESCE(s."steps", '[]'::jsonb))),
      'outreachEdited', true
    ) AS draft
    FROM "Campaign" c JOIN "Sequence" s ON s."id" = c."sequenceId"
    WHERE c."audience" = 'SANDBOX' AND c."plannerDraft" IS NULL
  ), done AS (
    UPDATE "Campaign" c SET "plannerDraft" = old.draft, "updatedAt" = stamp
    FROM old WHERE c."id" = old."id" AND c."plannerDraft" IS NULL
    RETURNING c."id", old."status", cardinality(old."personIds") AS people, jsonb_array_length(old.draft->'fos') AS fos
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'campaign', done."id", 'studio_plan_added', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261106300000_cold_campaigns_on_the_studio', 'status', done."status", 'people', done.people, 'fos', done.fos,
      'undo', 'Set plannerDraft back to null'), stamp
  FROM done;
END $$;

-- Classify the activity rows written before audience stamping (PLAN 9.7 step 4, B037) by where the
-- work happened, so the figures for past periods never move again:
--   - a row about a cold contact (sandboxContactId set) is cold outreach (SANDBOX), including the
--     rows of a contact that has since moved: the move does not rewrite the period it worked in;
--   - every other row is CRM;
--   - an enrollment takes its campaign's audience;
--   - a call nobody has been matched to stays null until it is; a form takes its call's.
--
-- One exception: a moved contact's open next step is live CRM work now. The cold row is closed
-- (CANCELLED, still SANDBOX) and the same step opens again as a CRM row dated from the move, with an
-- audit row (next_action_recreated) naming both ids, so either can be told from the other.
--
-- Only rows still null are touched, so running this again changes nothing. One audit row
-- (audience_backfill) records the counts when anything changed.
DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
  touches integer; calls integer; next_actions integer; enrollments integer; forms integer;
  recreated integer := 0;
  r record;
  new_id text;
BEGIN
  UPDATE "Touch" SET "audience" = (CASE WHEN "sandboxContactId" IS NOT NULL THEN 'SANDBOX' ELSE 'CRM' END)::"CampaignAudience"
  WHERE "audience" IS NULL;
  GET DIAGNOSTICS touches = ROW_COUNT;

  UPDATE "CallLog" SET "audience" = (CASE WHEN "sandboxContactId" IS NOT NULL THEN 'SANDBOX' ELSE 'CRM' END)::"CampaignAudience"
  WHERE "audience" IS NULL AND ("sandboxContactId" IS NOT NULL OR "personId" IS NOT NULL);
  GET DIAGNOSTICS calls = ROW_COUNT;

  UPDATE "NextAction" SET "audience" = (CASE WHEN "sandboxContactId" IS NOT NULL THEN 'SANDBOX' ELSE 'CRM' END)::"CampaignAudience"
  WHERE "audience" IS NULL;
  GET DIAGNOSTICS next_actions = ROW_COUNT;

  UPDATE "Enrollment" e SET "audience" = COALESCE(
    (SELECT c."audience" FROM "Campaign" c WHERE c."id" = e."campaignId"),
    (CASE WHEN e."sandboxContactId" IS NOT NULL THEN 'SANDBOX' ELSE 'CRM' END)::"CampaignAudience")
  WHERE e."audience" IS NULL;
  GET DIAGNOSTICS enrollments = ROW_COUNT;

  UPDATE "CallForm" f SET "audience" = c."audience" FROM "CallLog" c
  WHERE c."id" = f."callId" AND f."audience" IS NULL AND c."audience" IS NOT NULL;
  GET DIAGNOSTICS forms = ROW_COUNT;

  -- The move handed the contact's open next step to the CRM person (both ids set). Close it and open
  -- it again as CRM work. The old row goes first: one open next action per person (NextAction_one_open_per_person).
  FOR r IN
    SELECT n.*, s."movedAt" AS "contactMovedAt"
    FROM "NextAction" n JOIN "SandboxContact" s ON s."id" = n."sandboxContactId"
    WHERE n."state" = 'OPEN' AND n."personId" IS NOT NULL AND n."audience" = 'SANDBOX' AND s."status" = 'MOVED'
    ORDER BY n."id"
  LOOP
    new_id := gen_random_uuid()::text;
    UPDATE "NextAction" SET "state" = 'CANCELLED', "closedAt" = stamp, "updatedAt" = stamp WHERE "id" = r."id";
    INSERT INTO "NextAction" ("id", "personId", "sandboxContactId", "foUserId", "label", "action", "kind", "meetingAt", "dueDate", "repeat",
                              "state", "createdById", "doneCount", "crmPending", "crmSyncedAt", "crmError", "audience", "createdAt", "updatedAt")
    VALUES (new_id, r."personId", r."sandboxContactId", r."foUserId", r."label", r."action", r."kind", r."meetingAt", r."dueDate", r."repeat",
            'OPEN', r."createdById", 0, r."crmPending", r."crmSyncedAt", r."crmError", 'CRM', COALESCE(r."contactMovedAt", r."createdAt"), stamp);
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'sandbox_contact', r."sandboxContactId", 'next_action_recreated', 'SYSTEM', 'Cadence (release migration)',
            jsonb_build_object('migration', '20261105000101_audience_backfill', 'from', r."id", 'to', new_id, 'personId', r."personId",
                               'label', r."label", 'dueDate', r."dueDate", 'why', 'A moved contact''s open next step is CRM work from the move on.'),
            stamp);
    recreated := recreated + 1;
  END LOOP;

  IF touches + calls + next_actions + enrollments + forms + recreated > 0 THEN
    INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
    VALUES (gen_random_uuid()::text, 'settings', 'migrations', 'audience_backfill', 'SYSTEM', 'Cadence (release migration)', jsonb_build_object(
      'migration', '20261105000101_audience_backfill', 'touches', touches, 'calls', calls, 'nextActions', next_actions,
      'enrollments', enrollments, 'forms', forms, 'nextActionsRecreatedAsCrm', recreated), stamp);
  END IF;
END $$;

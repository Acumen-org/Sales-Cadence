-- S8 (cold outreach PLAN 6, 8.14): one reply counts once.
--
-- A rep's "They replied" on a cold step records a reply touch (externalId 'replied:<enrollmentId>'),
-- and Outlook tracking or the CRM's mail sync records the reply itself. When both describe the same
-- reply, whichever was recorded first counts and the other is marked as its copy (Touch.copyOfTouchId,
-- added in 20261105500000_touch_counted_once), which every figure leaves out. Both stay on the
-- contact's timeline. No schema change.
--
-- The pairs already written since 5 Nov: the same cold contact, a real email reply (not an
-- auto-reply), the mark made from ten minutes before the email came to seven days after it; each
-- mark and each email joined once, to its nearest partner. The one recorded later becomes the copy,
-- as the code does. Audited per touch. Idempotent: a joined touch is skipped on a second run.
DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH candidates AS (
    SELECT m."id" AS mark_id, t."id" AS tracked_id, m."sandboxContactId" AS contact_id,
      (m."createdAt", m."id") > (t."createdAt", t."id") AS mark_later,
      abs(extract(epoch FROM (m."occurredAt" - t."occurredAt"))) AS gap
    FROM "Touch" m
    JOIN "Touch" t ON t."sandboxContactId" = m."sandboxContactId" AND t."id" <> m."id"
    WHERE m."externalId" LIKE 'replied:%' AND m."copyOfTouchId" IS NULL AND m."direction" = 'INBOUND'
      AND t."externalId" NOT LIKE 'replied:%' AND t."direction" = 'INBOUND' AND t."channel" = 'EMAIL'
      AND t."copyOfTouchId" IS NULL AND t."summary" NOT LIKE 'Auto-reply%'
      AND m."occurredAt" >= t."occurredAt" - interval '10 minutes'
      AND m."occurredAt" <= t."occurredAt" + interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM "Touch" x WHERE x."copyOfTouchId" = m."id")
      AND NOT EXISTS (SELECT 1 FROM "Touch" x WHERE x."copyOfTouchId" = t."id" AND x."externalId" LIKE 'replied:%')
  ), per_mark AS (
    SELECT DISTINCT ON (mark_id) * FROM candidates ORDER BY mark_id, gap, tracked_id
  ), pairs AS (
    SELECT DISTINCT ON (tracked_id) * FROM per_mark ORDER BY tracked_id, gap, mark_id
  ), linked AS (
    UPDATE "Touch" u
    SET "copyOfTouchId" = CASE WHEN pairs.mark_later THEN pairs.tracked_id ELSE pairs.mark_id END
    FROM pairs
    WHERE u."id" = CASE WHEN pairs.mark_later THEN pairs.mark_id ELSE pairs.tracked_id END
      AND u."copyOfTouchId" IS NULL
    RETURNING u."id", u."copyOfTouchId", pairs.contact_id, pairs.mark_id
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', linked.contact_id, 'reply_counted_once', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261106000000_reply_counted_once', 'touchId', linked."id", 'countedAs', linked."copyOfTouchId", 'markId', linked.mark_id), stamp
  FROM linked;
END $$;

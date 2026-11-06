-- W10 (cold outreach PLAN 8.11): Outlook tracking keeps its place and says how each mailbox is doing.
--
-- N015: a first sync of a big mailbox stopped after 50 pages and started again on every run, so it
-- never finished. The page it reached is now kept (nextLink), the first read starts from the moment
-- tracking was switched on (startedAt), an expired sync link restarts from the last good run
-- (resetAt), and Settings shows each folder's last success and last error (lastSuccessAt, errorAt).
-- Additive; a folder already in step (a deltaLink and no error) counts its last run as a success.
ALTER TABLE "MailboxCursor"
  ADD COLUMN "nextLink" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN "errorAt" TIMESTAMP(3),
  ADD COLUMN "resetAt" TIMESTAMP(3);

UPDATE "MailboxCursor" SET "lastSuccessAt" = "lastRunAt" WHERE "deltaLink" IS NOT NULL AND "error" IS NULL AND "lastSuccessAt" IS NULL;
UPDATE "MailboxCursor" SET "errorAt" = "lastRunAt" WHERE "error" IS NOT NULL AND "errorAt" IS NULL;

-- N016: an email to a removed contact, whose details were cleared, is recognised by the hashes it
-- keeps (keptKeys, N027), so it raises the same alert as one to an opted-out contact.
CREATE INDEX "SandboxContact_keptKeys_idx" ON "SandboxContact" USING GIN ("keptKeys" jsonb_path_ops);

-- N097: a possible bounce was an invisible "bounce:check" tag, added again on every notice and
-- carried into the CRM's tags on a move. It becomes the dedicated field, set once (from the
-- contact's last change, the closest date there is), and the tag is dropped. Each contact changed
-- is audited. Idempotent: a second run finds no tag.
DO $$
DECLARE
  stamp timestamp(3) := now() AT TIME ZONE 'UTC';
BEGIN
  WITH done AS (
    UPDATE "SandboxContact"
    SET "possibleBounceAt" = COALESCE("possibleBounceAt", "updatedAt"), "tags" = array_remove("tags", 'bounce:check')
    WHERE 'bounce:check' = ANY("tags")
    RETURNING "id", "possibleBounceAt"
  )
  INSERT INTO "AuditLog" ("id", "entityType", "entityId", "action", "actorType", "actorLabel", "details", "createdAt")
  SELECT gen_random_uuid()::text, 'sandbox_contact', done."id", 'possible_bounce_backfill', 'SYSTEM', 'Cadence (release migration)',
    jsonb_build_object('migration', '20261105400000_mail_tracking_state', 'possibleBounceAt', done."possibleBounceAt", 'from', 'tag bounce:check'), stamp
  FROM done;
END $$;

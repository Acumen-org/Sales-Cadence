-- Meetings count per prospect (owner, 29 October 2026): each prospect's earliest meeting in
-- Cadence is their 1st, and a meeting is the highest of its prospects' numbers.
ALTER TABLE "Meeting" ADD COLUMN "transcriptTriedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "meetingNumber" INTEGER;
ALTER TABLE "MeetingAttendee" ADD COLUMN "prospect" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MeetingAttendee" ADD COLUMN "meetingNumber" INTEGER;
CREATE INDEX "MeetingAttendee_personId_prospect_idx" ON "MeetingAttendee"("personId", "prospect");

-- A prospect is a contact from Twenty who is not one of us.
UPDATE "MeetingAttendee" SET "prospect" = true WHERE "personId" IS NOT NULL AND "userId" IS NULL AND "external" = true;

WITH ranked AS (
  SELECT a."id", ROW_NUMBER() OVER (PARTITION BY a."personId" ORDER BY m."occurredAt", m."createdAt", m."id") AS n
  FROM "MeetingAttendee" a JOIN "Meeting" m ON m."id" = a."meetingId"
  WHERE a."prospect" AND m."review" = 'APPROVED'
)
UPDATE "MeetingAttendee" a SET "meetingNumber" = ranked.n FROM ranked WHERE ranked."id" = a."id";

UPDATE "Meeting" m SET "meetingNumber" = (SELECT MAX(a."meetingNumber") FROM "MeetingAttendee" a WHERE a."meetingId" = m."id" AND a."prospect");

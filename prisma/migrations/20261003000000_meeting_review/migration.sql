-- Meetings from the calendar wait for a pod manager's approval (owner, 25 September 2026).
CREATE TYPE "MeetingReview" AS ENUM ('PENDING', 'APPROVED', 'DISMISSED');

ALTER TABLE "Meeting" ADD COLUMN "review" "MeetingReview" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE INDEX "Meeting_review_occurredAt_idx" ON "Meeting"("review", "occurredAt");

-- What the first calendar import already added: nothing from the past is kept (it is hidden, not
-- deleted, so the calendar never adds it again), and what is still ahead waits for approval.
-- A meeting someone already worked on - edited, notes, recording, transcript, products, a star -
-- stays as it is.
UPDATE "Meeting" m SET "review" = CASE WHEN m."occurredAt" < now() THEN 'DISMISSED'::"MeetingReview" ELSE 'PENDING'::"MeetingReview" END
WHERE m."calendarEventId" IS NOT NULL
  AND m."createdById" IS NULL
  AND m."editedAt" IS NULL
  AND m."notes" IS NULL
  AND m."transcript" IS NULL
  AND m."mediaUrl" IS NULL
  AND m."analysisStatus" = 'NONE'
  AND cardinality(m."products") = 0
  AND NOT EXISTS (SELECT 1 FROM "MeetingFavourite" f WHERE f."meetingId" = m."id");

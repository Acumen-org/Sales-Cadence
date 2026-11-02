-- Every meeting numbered and Twenty always holding what Cadence wrote (owner, 2 November 2026):
-- what Cadence last wrote to each record, so the worker can tell when Twenty no longer holds it.
ALTER TABLE "Meeting" ADD COLUMN "twentySnapshot" JSONB;
ALTER TABLE "Meeting" ADD COLUMN "twentySyncedAt" TIMESTAMP(3);
CREATE INDEX "Meeting_twentyMeetingId_idx" ON "Meeting"("twentyMeetingId");

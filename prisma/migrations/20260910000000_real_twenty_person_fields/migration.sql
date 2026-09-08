-- The person cache now mirrors the real Twenty person object rather than the fields we
-- assumed. `eventSource` and `statusOfMeeting` do not exist in the workspace; `leadSource`
-- (multi-select) replaces the first, nothing replaces the second, and `ownerMemberId` now holds
-- `assignedToId`.

-- DropIndex is not needed: no index referenced the dropped columns.
ALTER TABLE "PersonCache" DROP COLUMN "eventSource";
ALTER TABLE "PersonCache" DROP COLUMN "statusOfMeeting";

ALTER TABLE "PersonCache" ADD COLUMN "dndReason" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "additionalEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PersonCache" ADD COLUMN "additionalPhone" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "xUrl" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "leadSource" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PersonCache" ADD COLUMN "leadSourceNotes" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "tier" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "contactType" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PersonCache" ADD COLUMN "listCategory" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "previousCadence" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "pipelineStage" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "productInterest" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PersonCache" ADD COLUMN "primaryProduct" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "campaigns" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PersonCache" ADD COLUMN "onCallingList" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PersonCache" ADD COLUMN "dealSignalStrength" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "emailMissing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PersonCache" ADD COLUMN "phoneMissing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PersonCache" ADD COLUMN "rotatedTo" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "rotationChangedAt" TIMESTAMP(3);
ALTER TABLE "PersonCache" ADD COLUMN "nextAction" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "nextActionDueDate" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "nextStep" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "nextActionDueDatePoc" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "lastNote" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "lastCallAt" TIMESTAMP(3);
ALTER TABLE "PersonCache" ADD COLUMN "lastEmailAt" TIMESTAMP(3);
ALTER TABLE "PersonCache" ADD COLUMN "meetingUrl" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "recordingUrl" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "bookingId" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "createdBySource" TEXT;
ALTER TABLE "PersonCache" ADD COLUMN "createdByName" TEXT;

CREATE INDEX "PersonCache_tier_idx" ON "PersonCache"("tier");
CREATE INDEX "PersonCache_listCategory_idx" ON "PersonCache"("listCategory");
CREATE INDEX "PersonCache_nextActionDueDate_idx" ON "PersonCache"("nextActionDueDate");

-- Every cached person is stale now: the next sync refills the new columns.
UPDATE "PersonCache" SET "syncedAt" = TIMESTAMP '1970-01-01 00:00:00';

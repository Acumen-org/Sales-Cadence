ALTER TYPE "Role" ADD VALUE 'SALES_LEADER';
ALTER TYPE "CampaignStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "CampaignStatus" ADD VALUE 'SCHEDULED';
ALTER TABLE "User" ALTER COLUMN "timezone" SET DEFAULT 'America/Chicago';
ALTER TABLE "User" ADD COLUMN "notificationsReadAt" TIMESTAMP(3);
UPDATE "User" SET "timezone" = 'America/Chicago';
ALTER TABLE "Pod" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "followupSourceId" TEXT,
  ADD COLUMN "followupWaitDays" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvedAt" TIMESTAMP(3), ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "runNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Enrollment" ADD COLUMN "campaignRun" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Task" ADD COLUMN "draftSubject" TEXT, ADD COLUMN "draftHtml" TEXT,
  ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "actionSnapshot" JSONB;
UPDATE "Task" SET "dueAt" = ((COALESCE("snoozedTo", "dueDate") || ' 09:00:00')::timestamp AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC' WHERE "state" = 'PENDING';
ALTER TABLE "CompanyCache" ADD COLUMN "aum" DECIMAL(24,2);
CREATE TABLE "EnrichmentBatch" (
  "id" TEXT NOT NULL, "entity" TEXT NOT NULL, "name" TEXT NOT NULL,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrichmentBatch_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EnrichmentRow" (
  "id" TEXT NOT NULL, "batchId" TEXT NOT NULL, "rowNumber" INTEGER NOT NULL,
  "recordId" TEXT, "recordLabel" TEXT, "input" JSONB NOT NULL,
  "changes" JSONB NOT NULL, "original" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY', "error" TEXT, "appliedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnrichmentRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EnrichmentRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EnrichmentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnrichmentRow_batchId_rowNumber_key" ON "EnrichmentRow"("batchId", "rowNumber");
CREATE INDEX "EnrichmentRow_batchId_status_idx" ON "EnrichmentRow"("batchId", "status");

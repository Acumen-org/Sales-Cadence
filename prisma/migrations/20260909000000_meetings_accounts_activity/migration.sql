-- CreateEnum
CREATE TYPE "MeetingProvider" AS ENUM ('TEAMS', 'ZOOM', 'GOOGLE_MEET', 'SHAREPOINT', 'DRIVE', 'FILE', 'OTHER');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('CHAMPION', 'SUPPORTER', 'NEUTRAL', 'DETRACTOR', 'UNKNOWN');

-- AlterTable
ALTER TABLE "PersonCache" ADD COLUMN     "accountRole" "AccountRole" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "relationshipNote" TEXT,
ADD COLUMN     "reportsToId" TEXT;

-- AlterTable
ALTER TABLE "CompanyCache" ADD COLUMN     "city" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "employees" INTEGER,
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "linkedinUrl" TEXT,
ADD COLUMN     "ownerMemberId" TEXT,
ADD COLUMN     "raw" JSONB,
ADD COLUMN     "twentyUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider" "MeetingProvider" NOT NULL DEFAULT 'OTHER',
    "sourceUrl" TEXT NOT NULL,
    "embedUrl" TEXT,
    "mediaUrl" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER,
    "companyId" TEXT,
    "companyName" TEXT,
    "notes" TEXT,
    "transcript" TEXT,
    "transcriptFormat" TEXT,
    "analysis" JSONB,
    "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'NONE',
    "analysisModel" TEXT,
    "analysisError" TEXT,
    "analysedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingAttendee" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "personId" TEXT,
    "userId" TEXT,
    "external" BOOLEAN NOT NULL DEFAULT false,
    "host" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MeetingAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_occurredAt_idx" ON "Meeting"("occurredAt");

-- CreateIndex
CREATE INDEX "Meeting_companyId_occurredAt_idx" ON "Meeting"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "Meeting_createdById_idx" ON "Meeting"("createdById");

-- CreateIndex
CREATE INDEX "Meeting_analysisStatus_idx" ON "Meeting"("analysisStatus");

-- CreateIndex
CREATE INDEX "MeetingAttendee_meetingId_idx" ON "MeetingAttendee"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingAttendee_personId_idx" ON "MeetingAttendee"("personId");

-- CreateIndex
CREATE INDEX "MeetingAttendee_email_idx" ON "MeetingAttendee"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAttendee_meetingId_email_key" ON "MeetingAttendee"("meetingId", "email");

-- CreateIndex
CREATE INDEX "Enrollment_foUserId_repliedAt_idx" ON "Enrollment"("foUserId", "repliedAt");

-- CreateIndex
CREATE INDEX "Enrollment_foUserId_meetingAt_idx" ON "Enrollment"("foUserId", "meetingAt");

-- CreateIndex
CREATE INDEX "Task_foUserId_state_completedAt_idx" ON "Task"("foUserId", "state", "completedAt");

-- CreateIndex
CREATE INDEX "Task_state_completedAt_idx" ON "Task"("state", "completedAt");

-- CreateIndex
CREATE INDEX "Task_foUserId_snoozedTo_idx" ON "Task"("foUserId", "snoozedTo");

-- CreateIndex
CREATE INDEX "PersonCache_reportsToId_idx" ON "PersonCache"("reportsToId");

-- CreateIndex
CREATE INDEX "PersonCache_companyId_lastName_idx" ON "PersonCache"("companyId", "lastName");

-- CreateIndex
CREATE INDEX "CompanyCache_ownerMemberId_idx" ON "CompanyCache"("ownerMemberId");

-- CreateIndex
CREATE INDEX "CompanyCache_name_idx" ON "CompanyCache"("name");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_createdAt_idx" ON "AuditLog"("entityType", "createdAt");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanyCache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE SET NULL ON UPDATE CASCADE;


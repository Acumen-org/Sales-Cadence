-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SENIOR_FO', 'JUNIOR_FO');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('EMAIL', 'CALL', 'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REPLIED', 'MEETING', 'COMPLETED', 'EXITED');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('PENDING', 'DONE', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'STOPPED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CampaignSource" AS ENUM ('IDS', 'CSV', 'TWENTY_VIEW');

-- CreateEnum
CREATE TYPE "AssignmentMode" AS ENUM ('OWNER', 'ROUND_ROBIN');

-- CreateEnum
CREATE TYPE "CompletionSource" AS ENUM ('OBSERVED_MESSAGE', 'OBSERVED_NOTE', 'OBSERVED_TWENTY_TASK', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('WEBHOOK', 'RECONCILE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'WEBHOOK', 'SYSTEM', 'RECONCILE');

-- CreateEnum
CREATE TYPE "TouchDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'CALL', 'LINKEDIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "twentyMemberId" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "dailyCap" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "podOwnerValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPod" (
    "userId" TEXT NOT NULL,
    "podId" TEXT NOT NULL,

    CONSTRAINT "UserPod_pkey" PRIMARY KEY ("userId","podId")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceVersion" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SequenceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "sourceType" "CampaignSource" NOT NULL DEFAULT 'IDS',
    "sourceRef" TEXT,
    "personIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignmentMode" "AssignmentMode" NOT NULL DEFAULT 'OWNER',
    "startDate" TEXT NOT NULL,
    "dailyRampPerFo" INTEGER,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "companyId" TEXT,
    "foUserId" TEXT NOT NULL,
    "podId" TEXT,
    "campaignId" TEXT,
    "sequenceId" TEXT NOT NULL,
    "sequenceVersionId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT -1,
    "shiftDays" INTEGER NOT NULL DEFAULT 0,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "exitReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "repliedAt" TIMESTAMP(3),
    "meetingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "foUserId" TEXT NOT NULL,
    "sequenceVersionId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepDay" INTEGER NOT NULL,
    "actionIndex" INTEGER NOT NULL,
    "actionId" TEXT NOT NULL,
    "action" "ActionType" NOT NULL,
    "altAction" "ActionType",
    "chosenAction" "ActionType",
    "label" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "plannedDate" TEXT NOT NULL,
    "snoozedTo" TEXT,
    "state" "TaskState" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completionSource" "CompletionSource",
    "evidenceId" TEXT,
    "skipReason" TEXT,
    "cancelReason" TEXT,
    "twentyTaskId" TEXT,
    "twentyNoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonCache" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "jobTitle" TEXT,
    "companyId" TEXT,
    "companyName" TEXT,
    "dnd" BOOLEAN NOT NULL DEFAULT false,
    "podOwner" TEXT,
    "ownerMemberId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eventSource" TEXT,
    "statusOfMeeting" TEXT,
    "city" TEXT,
    "raw" JSONB,
    "twentyUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyCache" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Touch" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "direction" "TouchDirection" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Touch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "source" "EventSource" NOT NULL,
    "objectType" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUpdatedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwentyWrite" (
    "id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "twentyId" TEXT,
    "taskId" TEXT,
    "payload" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwentyWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_twentyMemberId_key" ON "User"("twentyMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Pod_name_key" ON "Pod"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Pod_podOwnerValue_key" ON "Pod"("podOwnerValue");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_name_key" ON "Sequence"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_activeVersionId_key" ON "Sequence"("activeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceVersion_sequenceId_version_key" ON "SequenceVersion"("sequenceId", "version");

-- CreateIndex
CREATE INDEX "Enrollment_personId_status_idx" ON "Enrollment"("personId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_foUserId_status_idx" ON "Enrollment"("foUserId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_campaignId_idx" ON "Enrollment"("campaignId");

-- CreateIndex
CREATE INDEX "Enrollment_companyId_idx" ON "Enrollment"("companyId");

-- CreateIndex
CREATE INDEX "Enrollment_status_idx" ON "Enrollment"("status");

-- CreateIndex
CREATE INDEX "Task_foUserId_state_dueDate_idx" ON "Task"("foUserId", "state", "dueDate");

-- CreateIndex
CREATE INDEX "Task_state_dueDate_idx" ON "Task"("state", "dueDate");

-- CreateIndex
CREATE INDEX "Task_evidenceId_idx" ON "Task"("evidenceId");

-- CreateIndex
CREATE INDEX "Task_twentyTaskId_idx" ON "Task"("twentyTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_enrollmentId_stepIndex_actionIndex_key" ON "Task"("enrollmentId", "stepIndex", "actionIndex");

-- CreateIndex
CREATE INDEX "PersonCache_companyId_idx" ON "PersonCache"("companyId");

-- CreateIndex
CREATE INDEX "PersonCache_podOwner_idx" ON "PersonCache"("podOwner");

-- CreateIndex
CREATE INDEX "PersonCache_email_idx" ON "PersonCache"("email");

-- CreateIndex
CREATE INDEX "PersonCache_lastName_firstName_idx" ON "PersonCache"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "PersonCache_ownerMemberId_idx" ON "PersonCache"("ownerMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Touch_externalId_key" ON "Touch"("externalId");

-- CreateIndex
CREATE INDEX "Touch_personId_occurredAt_idx" ON "Touch"("personId", "occurredAt");

-- CreateIndex
CREATE INDEX "Touch_occurredAt_idx" ON "Touch"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_dedupeKey_key" ON "ActivityEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ActivityEvent_objectType_externalId_idx" ON "ActivityEvent"("objectType", "externalId");

-- CreateIndex
CREATE INDEX "ActivityEvent_needsReview_idx" ON "ActivityEvent"("needsReview");

-- CreateIndex
CREATE INDEX "ActivityEvent_receivedAt_idx" ON "ActivityEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "TwentyWrite_taskId_idx" ON "TwentyWrite"("taskId");

-- CreateIndex
CREATE INDEX "TwentyWrite_twentyId_idx" ON "TwentyWrite"("twentyId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPod" ADD CONSTRAINT "UserPod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPod" ADD CONSTRAINT "UserPod_podId_fkey" FOREIGN KEY ("podId") REFERENCES "Pod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "SequenceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceVersion" ADD CONSTRAINT "SequenceVersion_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_podId_fkey" FOREIGN KEY ("podId") REFERENCES "Pod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_foUserId_fkey" FOREIGN KEY ("foUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_podId_fkey" FOREIGN KEY ("podId") REFERENCES "Pod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sequenceVersionId_fkey" FOREIGN KEY ("sequenceVersionId") REFERENCES "SequenceVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_foUserId_fkey" FOREIGN KEY ("foUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sequenceVersionId_fkey" FOREIGN KEY ("sequenceVersionId") REFERENCES "SequenceVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Touch" ADD CONSTRAINT "Touch_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Cadence rule 4: one active enrollment per person across all campaigns.
-- ACTIVE and PAUSED both occupy the slot. Enforced here in addition to the application check.
CREATE UNIQUE INDEX "Enrollment_one_active_per_person" ON "Enrollment"("personId") WHERE "status" IN ('ACTIVE', 'PAUSED');

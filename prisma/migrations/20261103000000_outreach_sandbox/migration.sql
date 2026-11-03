-- Outreach sandbox (docs/outreach-sandbox-plan.md, section 4). Every object is new or optional:
-- nothing is rewritten, and dropping NOT NULL only changes metadata, so this applies to the live
-- database with the app running.

-- CreateEnum
CREATE TYPE "CampaignAudience" AS ENUM ('CRM', 'SANDBOX');

-- CreateEnum
CREATE TYPE "SandboxStatus" AS ENUM ('ACTIVE', 'MOVED', 'OPTED_OUT', 'REMOVED');

-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('BELLWETHER', 'MANUAL', 'CSV', 'CALL');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('QUEUED', 'INITIATED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CallSource" AS ENUM ('TWILIO_IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "SandboxEmailKind" AS ENUM ('SENT', 'REPLY', 'AUTO_REPLY', 'BOUNCE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "callerNumber" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "audience" "CampaignAudience" NOT NULL DEFAULT 'CRM';

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "sandboxContactId" TEXT,
ALTER COLUMN "personId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PersonCache" ADD COLUMN     "additionalPhoneE164" TEXT,
ADD COLUMN     "phoneE164" TEXT;

-- AlterTable
ALTER TABLE "Touch" ADD COLUMN     "sandboxContactId" TEXT,
ALTER COLUMN "personId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "NextAction" ADD COLUMN     "sandboxContactId" TEXT,
ALTER COLUMN "personId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SandboxContact" (
    "id" TEXT NOT NULL,
    "status" "SandboxStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ContactSource" NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "sortName" TEXT,
    "jobTitle" TEXT,
    "email" TEXT,
    "emailVerification" TEXT,
    "additionalEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" TEXT,
    "phoneType" TEXT,
    "phoneExtension" TEXT,
    "additionalPhones" JSONB NOT NULL DEFAULT '[]',
    "linkedinUrl" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "individualCrd" TEXT,
    "designations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productInterest" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "companyName" TEXT,
    "companyDomain" TEXT,
    "companyWebsite" TEXT,
    "companyCrd" TEXT,
    "companyCity" TEXT,
    "companyState" TEXT,
    "companyCountry" TEXT,
    "companyPhone" TEXT,
    "companyAumUsd" DECIMAL(24,2),
    "companyEmployees" INTEGER,
    "ownerId" TEXT,
    "podId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "bellwetherContactId" TEXT,
    "bellwetherAliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bellwetherUrl" TEXT,
    "sourceNote" TEXT,
    "collectedAt" TEXT,
    "pushedByEmail" TEXT,
    "createdById" TEXT,
    "badEmail" BOOLEAN NOT NULL DEFAULT false,
    "badPhone" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "optOutReason" TEXT,
    "lawfulBasis" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "movedAt" TIMESTAMP(3),
    "movedById" TEXT,
    "twentyPersonId" TEXT,
    "twentyCompanyId" TEXT,
    "piiClearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxNote" (
    "id" TEXT NOT NULL,
    "sandboxContactId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "twentyNoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "valueHash" TEXT NOT NULL,
    "label" TEXT,
    "reason" TEXT NOT NULL,
    "sandboxContactId" TEXT,
    "personId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "source" "CallSource" NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "twilioCallSid" TEXT,
    "parentCallSid" TEXT,
    "fromNumber" TEXT,
    "toNumber" TEXT,
    "repIdentity" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'QUEUED',
    "statusRank" INTEGER NOT NULL DEFAULT 0,
    "twilioStatus" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "talkSec" INTEGER,
    "priceUsd" DECIMAL(10,4),
    "userId" TEXT,
    "repMatchedBy" TEXT,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "matchedBy" TEXT,
    "candidates" JSONB,
    "taskId" TEXT,
    "nextActionId" TEXT,
    "enrollmentId" TEXT,
    "campaignId" TEXT,
    "touchId" TEXT,
    "recordingSid" TEXT,
    "recordingSec" INTEGER,
    "recordingCount" INTEGER NOT NULL DEFAULT 0,
    "formDueAt" TIMESTAMP(3),
    "formDoneAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "taskId" TEXT,
    "nextActionId" TEXT,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallForm" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "rating" INTEGER,
    "notes" TEXT,
    "nextStep" TEXT NOT NULL,
    "nextStepDate" TEXT,
    "interest" TEXT,
    "productsDiscussed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decisionMaker" TEXT,
    "nextActionId" TEXT,
    "twentyNoteId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxEmail" (
    "id" TEXT NOT NULL,
    "sandboxContactId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "SandboxEmailKind" NOT NULL,
    "internetMessageId" TEXT NOT NULL,
    "conversationId" TEXT,
    "subject" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "taskId" TEXT,
    "touchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxCursor" (
    "userId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "deltaLink" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MailboxCursor_pkey" PRIMARY KEY ("userId","folder")
);

-- CreateTable
CREATE TABLE "BellwetherPush" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pushedByEmail" TEXT NOT NULL,
    "ownerId" TEXT,
    "contactCount" INTEGER NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BellwetherPush_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BellwetherPushItem" (
    "id" TEXT NOT NULL,
    "pushId" TEXT NOT NULL,
    "bellwetherContactId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "sandboxContactId" TEXT,
    "crmPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BellwetherPushItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BellwetherRefusal" (
    "bellwetherContactId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "crmPersonId" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BellwetherRefusal_pkey" PRIMARY KEY ("bellwetherContactId")
);

-- CreateTable
CREATE TABLE "SandboxMove" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SandboxMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxMoveItem" (
    "id" TEXT NOT NULL,
    "moveId" TEXT NOT NULL,
    "sandboxContactId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "attachPersonId" TEXT,
    "chosenCompanyId" TEXT,
    "companyAction" TEXT,
    "twentyPersonId" TEXT,
    "twentyCompanyId" TEXT,
    "notesWritten" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "personUpdatedAt" TEXT,
    "snapshot" JSONB NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "SandboxMoveItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SandboxContact_bellwetherContactId_key" ON "SandboxContact"("bellwetherContactId");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxContact_twentyPersonId_key" ON "SandboxContact"("twentyPersonId");

-- CreateIndex
CREATE INDEX "SandboxContact_status_ownerId_idx" ON "SandboxContact"("status", "ownerId");

-- CreateIndex
CREATE INDEX "SandboxContact_status_podId_idx" ON "SandboxContact"("status", "podId");

-- CreateIndex
CREATE INDEX "SandboxContact_status_lastActivityAt_idx" ON "SandboxContact"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SandboxContact_statusChangedAt_idx" ON "SandboxContact"("statusChangedAt");

-- CreateIndex
CREATE INDEX "SandboxContact_email_idx" ON "SandboxContact"("email");

-- CreateIndex
CREATE INDEX "SandboxContact_phone_idx" ON "SandboxContact"("phone");

-- CreateIndex
CREATE INDEX "SandboxContact_linkedinUrl_idx" ON "SandboxContact"("linkedinUrl");

-- CreateIndex
CREATE INDEX "SandboxContact_individualCrd_idx" ON "SandboxContact"("individualCrd");

-- CreateIndex
CREATE INDEX "SandboxContact_companyDomain_idx" ON "SandboxContact"("companyDomain");

-- CreateIndex
CREATE INDEX "SandboxContact_sortName_idx" ON "SandboxContact"("sortName");

-- CreateIndex
CREATE INDEX "SandboxNote_sandboxContactId_createdAt_idx" ON "SandboxNote"("sandboxContactId", "createdAt");

-- CreateIndex
CREATE INDEX "Suppression_createdAt_idx" ON "Suppression"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_kind_valueHash_key" ON "Suppression"("kind", "valueHash");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_twilioCallSid_key" ON "CallLog"("twilioCallSid");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_touchId_key" ON "CallLog"("touchId");

-- CreateIndex
CREATE INDEX "CallLog_userId_startedAt_idx" ON "CallLog"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "CallLog_userId_formDoneAt_idx" ON "CallLog"("userId", "formDoneAt");

-- CreateIndex
CREATE INDEX "CallLog_personId_startedAt_idx" ON "CallLog"("personId", "startedAt");

-- CreateIndex
CREATE INDEX "CallLog_sandboxContactId_startedAt_idx" ON "CallLog"("sandboxContactId", "startedAt");

-- CreateIndex
CREATE INDEX "CallLog_campaignId_startedAt_idx" ON "CallLog"("campaignId", "startedAt");

-- CreateIndex
CREATE INDEX "CallLog_startedAt_idx" ON "CallLog"("startedAt");

-- CreateIndex
CREATE INDEX "CallLog_toNumber_idx" ON "CallLog"("toNumber");

-- CreateIndex
CREATE INDEX "CallLog_fromNumber_idx" ON "CallLog"("fromNumber");

-- CreateIndex
CREATE INDEX "CallLog_parentCallSid_idx" ON "CallLog"("parentCallSid");

-- CreateIndex
CREATE INDEX "CallLog_status_startedAt_idx" ON "CallLog"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallIntent_callId_key" ON "CallIntent"("callId");

-- CreateIndex
CREATE INDEX "CallIntent_userId_toNumber_createdAt_idx" ON "CallIntent"("userId", "toNumber", "createdAt");

-- CreateIndex
CREATE INDEX "CallIntent_toNumber_createdAt_idx" ON "CallIntent"("toNumber", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallForm_callId_key" ON "CallForm"("callId");

-- CreateIndex
CREATE INDEX "SandboxEmail_sandboxContactId_at_idx" ON "SandboxEmail"("sandboxContactId", "at");

-- CreateIndex
CREATE INDEX "SandboxEmail_conversationId_idx" ON "SandboxEmail"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxEmail_internetMessageId_sandboxContactId_key" ON "SandboxEmail"("internetMessageId", "sandboxContactId");

-- CreateIndex
CREATE UNIQUE INDEX "BellwetherPush_idempotencyKey_key" ON "BellwetherPush"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BellwetherPush_createdAt_idx" ON "BellwetherPush"("createdAt");

-- CreateIndex
CREATE INDEX "BellwetherPushItem_bellwetherContactId_createdAt_idx" ON "BellwetherPushItem"("bellwetherContactId", "createdAt");

-- CreateIndex
CREATE INDEX "BellwetherRefusal_statusChangedAt_idx" ON "BellwetherRefusal"("statusChangedAt");

-- CreateIndex
CREATE INDEX "SandboxMove_createdAt_idx" ON "SandboxMove"("createdAt");

-- CreateIndex
CREATE INDEX "SandboxMoveItem_moveId_idx" ON "SandboxMoveItem"("moveId");

-- CreateIndex
CREATE INDEX "SandboxMoveItem_sandboxContactId_idx" ON "SandboxMoveItem"("sandboxContactId");

-- CreateIndex
CREATE INDEX "SandboxMoveItem_state_idx" ON "SandboxMoveItem"("state");

-- CreateIndex
CREATE UNIQUE INDEX "User_callerNumber_key" ON "User"("callerNumber");

-- CreateIndex
CREATE INDEX "Campaign_audience_status_idx" ON "Campaign"("audience", "status");

-- CreateIndex
CREATE INDEX "Enrollment_sandboxContactId_status_idx" ON "Enrollment"("sandboxContactId", "status");

-- CreateIndex
CREATE INDEX "PersonCache_phoneE164_idx" ON "PersonCache"("phoneE164");

-- CreateIndex
CREATE INDEX "PersonCache_additionalPhoneE164_idx" ON "PersonCache"("additionalPhoneE164");

-- CreateIndex
CREATE INDEX "PersonCache_linkedinUrl_idx" ON "PersonCache"("linkedinUrl");

-- CreateIndex
CREATE INDEX "Touch_sandboxContactId_occurredAt_idx" ON "Touch"("sandboxContactId", "occurredAt");

-- CreateIndex
CREATE INDEX "NextAction_sandboxContactId_state_idx" ON "NextAction"("sandboxContactId", "state");

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Touch" ADD CONSTRAINT "Touch_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NextAction" ADD CONSTRAINT "NextAction_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContact" ADD CONSTRAINT "SandboxContact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContact" ADD CONSTRAINT "SandboxContact_podId_fkey" FOREIGN KEY ("podId") REFERENCES "Pod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxNote" ADD CONSTRAINT "SandboxNote_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallForm" ADD CONSTRAINT "CallForm_callId_fkey" FOREIGN KEY ("callId") REFERENCES "CallLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxEmail" ADD CONSTRAINT "SandboxEmail_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BellwetherPushItem" ADD CONSTRAINT "BellwetherPushItem_pushId_fkey" FOREIGN KEY ("pushId") REFERENCES "BellwetherPush"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxMoveItem" ADD CONSTRAINT "SandboxMoveItem_moveId_fkey" FOREIGN KEY ("moveId") REFERENCES "SandboxMove"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An enrollment, next action or touch belongs to a person, a sandbox contact, or both (a sandbox
-- contact that has since moved to the CRM). Added NOT VALID, then validated, so no table is locked
-- for a full scan.
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_has_subject" CHECK ("personId" IS NOT NULL OR "sandboxContactId" IS NOT NULL) NOT VALID;
ALTER TABLE "Enrollment" VALIDATE CONSTRAINT "Enrollment_has_subject";
ALTER TABLE "NextAction" ADD CONSTRAINT "NextAction_has_subject" CHECK ("personId" IS NOT NULL OR "sandboxContactId" IS NOT NULL) NOT VALID;
ALTER TABLE "NextAction" VALIDATE CONSTRAINT "NextAction_has_subject";
ALTER TABLE "Touch" ADD CONSTRAINT "Touch_has_subject" CHECK ("personId" IS NOT NULL OR "sandboxContactId" IS NOT NULL) NOT VALID;
ALTER TABLE "Touch" VALIDATE CONSTRAINT "Touch_has_subject";

-- One running sequence per sandbox contact, the twin of Enrollment_one_active_per_person.
CREATE UNIQUE INDEX "Enrollment_one_active_per_sandbox_contact" ON "Enrollment"("sandboxContactId") WHERE "status" IN ('ACTIVE', 'PAUSED') AND "personId" IS NULL;

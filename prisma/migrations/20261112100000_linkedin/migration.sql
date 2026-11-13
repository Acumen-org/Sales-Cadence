-- CreateEnum
CREATE TYPE "LinkedInLinkStatus" AS ENUM ('PENDING', 'ACCEPTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "LinkedInFollowUpKind" AS ENUM ('MESSAGE', 'WITHDRAW', 'RESEND');

-- CreateEnum
CREATE TYPE "LinkedInFollowUpState" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ContactSource" ADD VALUE 'LINKEDIN';

-- AlterTable
ALTER TABLE "PersonCache" ADD COLUMN     "linkedinKey" TEXT;

-- CreateTable
CREATE TABLE "LinkedInAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invitesLast7Days" INTEGER NOT NULL DEFAULT 0,
    "inviteWeeklyLimit" INTEGER,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedInEvent" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "userEmail" TEXT,
    "userId" TEXT,
    "memberUrn" TEXT,
    "profileKey" TEXT,
    "name" TEXT,
    "payload" JSONB NOT NULL,
    "via" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,
    "personId" TEXT,
    "sandboxContactId" TEXT,

    CONSTRAINT "LinkedInEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedInLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "memberUrn" TEXT,
    "name" TEXT,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "status" "LinkedInLinkStatus" NOT NULL,
    "invitedByUs" BOOLEAN NOT NULL DEFAULT true,
    "invitedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "resends" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "lastReplyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedInFollowUp" (
    "id" TEXT NOT NULL,
    "kind" "LinkedInFollowUpKind" NOT NULL,
    "state" "LinkedInFollowUpState" NOT NULL DEFAULT 'OPEN',
    "linkId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "foUserId" TEXT,
    "trigger" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "dueDate" TEXT,
    "assignedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completionSource" "CompletionSource",
    "evidenceId" TEXT,
    "closeReason" TEXT,
    "audience" "CampaignAudience",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInEvent_seq_key" ON "LinkedInEvent"("seq");

-- CreateIndex
CREATE INDEX "LinkedInEvent_processedAt_idx" ON "LinkedInEvent"("processedAt");

-- CreateIndex
CREATE INDEX "LinkedInEvent_profileKey_idx" ON "LinkedInEvent"("profileKey");

-- CreateIndex
CREATE INDEX "LinkedInEvent_memberUrn_idx" ON "LinkedInEvent"("memberUrn");

-- CreateIndex
CREATE INDEX "LinkedInEvent_result_idx" ON "LinkedInEvent"("result");

-- CreateIndex
CREATE INDEX "LinkedInEvent_at_idx" ON "LinkedInEvent"("at");

-- CreateIndex
CREATE INDEX "LinkedInLink_personId_idx" ON "LinkedInLink"("personId");

-- CreateIndex
CREATE INDEX "LinkedInLink_sandboxContactId_idx" ON "LinkedInLink"("sandboxContactId");

-- CreateIndex
CREATE INDEX "LinkedInLink_profileKey_idx" ON "LinkedInLink"("profileKey");

-- CreateIndex
CREATE INDEX "LinkedInLink_status_invitedAt_idx" ON "LinkedInLink"("status", "invitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInLink_accountId_profileKey_key" ON "LinkedInLink"("accountId", "profileKey");

-- CreateIndex
CREATE INDEX "LinkedInFollowUp_foUserId_state_dueDate_idx" ON "LinkedInFollowUp"("foUserId", "state", "dueDate");

-- CreateIndex
CREATE INDEX "LinkedInFollowUp_state_foUserId_idx" ON "LinkedInFollowUp"("state", "foUserId");

-- CreateIndex
CREATE INDEX "LinkedInFollowUp_personId_state_idx" ON "LinkedInFollowUp"("personId", "state");

-- CreateIndex
CREATE INDEX "LinkedInFollowUp_sandboxContactId_state_idx" ON "LinkedInFollowUp"("sandboxContactId", "state");

-- CreateIndex
CREATE INDEX "PersonCache_linkedinKey_idx" ON "PersonCache"("linkedinKey");

-- AddForeignKey
ALTER TABLE "LinkedInFollowUp" ADD CONSTRAINT "LinkedInFollowUp_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "LinkedInLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedInFollowUp" ADD CONSTRAINT "LinkedInFollowUp_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedInFollowUp" ADD CONSTRAINT "LinkedInFollowUp_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedInFollowUp" ADD CONSTRAINT "LinkedInFollowUp_foUserId_fkey" FOREIGN KEY ("foUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One open follow-up of a kind per link (Prisma cannot declare a partial unique index).
CREATE UNIQUE INDEX "LinkedInFollowUp_one_open_per_link" ON "LinkedInFollowUp"("linkId", "kind") WHERE "state" = 'OPEN';

-- The profile key of every person already cached: linkedin.com/in/<slug>, lower-cased, as
-- normalizeLinkedin makes it (URL-encoded slugs are decoded by the next cache refresh).
UPDATE "PersonCache"
SET "linkedinKey" = lower(substring(regexp_replace(regexp_replace(trim("linkedinUrl"), '^[a-zA-Z]+://', ''), '^(www\.|[a-zA-Z]{2}\.|m\.)', '') FROM '^linkedin\.com/in/([^/?#[:space:]]+)'))
WHERE "linkedinUrl" IS NOT NULL;
UPDATE "PersonCache" SET "linkedinKey" = 'linkedin.com/in/' || "linkedinKey" WHERE "linkedinKey" IS NOT NULL AND "linkedinKey" NOT LIKE 'linkedin.com/in/%';

-- "Reply to their email" tasks (owner, 13 Nov 2026) live beside the LinkedIn follow-ups.
ALTER TYPE "LinkedInFollowUpKind" ADD VALUE 'EMAIL_REPLY';
ALTER TABLE "LinkedInFollowUp" ALTER COLUMN "linkId" DROP NOT NULL;
ALTER TABLE "LinkedInFollowUp" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "LinkedInFollowUp" ADD COLUMN "sourceId" TEXT;
-- One task per reply.
CREATE UNIQUE INDEX "LinkedInFollowUp_sourceId_key" ON "LinkedInFollowUp"("sourceId");

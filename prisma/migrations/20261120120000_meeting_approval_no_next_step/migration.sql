-- Meetings with no recording link wait for the booked-by FO's Sales Leader (or an admin); a decline takes them out.
CREATE TYPE "MeetingApproval" AS ENUM ('WAITING', 'APPROVED', 'DECLINED');
ALTER TABLE "Meeting" ADD COLUMN "approval" "MeetingApproval";
ALTER TABLE "Meeting" ADD COLUMN "approvalById" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "approvalAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "declinedById" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "declinedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_approvalById_fkey" FOREIGN KEY ("approvalById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_declinedById_fkey" FOREIGN KEY ("declinedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Meeting_approval_occurredAt_idx" ON "Meeting"("approval", "occurredAt");

-- A reached call can end with no next step, with the rep's reason.
ALTER TABLE "CallForm" ADD COLUMN "noNextStepReason" TEXT;

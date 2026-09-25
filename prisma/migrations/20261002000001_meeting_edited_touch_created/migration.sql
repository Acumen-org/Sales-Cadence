-- Edited by hand: from then on only a calendar meeting's time follows its invite.
ALTER TABLE "Meeting" ADD COLUMN "editedAt" TIMESTAMP(3);
-- The bell and the live refresh ask for the newest touch every few seconds.
CREATE INDEX "Touch_createdAt_idx" ON "Touch"("createdAt");

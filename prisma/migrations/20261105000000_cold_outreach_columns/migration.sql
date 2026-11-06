-- Cold outreach rebuild, data model (PLAN 8.12, W1). Every change here only adds: new enums,
-- nullable columns, and NOT NULL columns with a constant default, which Postgres records without
-- rewriting the table. Nothing can fail on existing rows, so this applies to the live database
-- with the app running. The next migration fills what can be worked out from the rows already there.

-- A next action that is a booked meeting rather than something to do (B183).
CREATE TYPE "NextActionKind" AS ENUM ('ACTION', 'MEETING');

ALTER TABLE "NextAction" ADD COLUMN "kind" "NextActionKind" NOT NULL DEFAULT 'ACTION',
ADD COLUMN "meetingAt" TIMESTAMP(3);

-- Calls: the pod they count for (B040), a discarded mistaken log (B024), recording found or not (N050).
ALTER TABLE "CallLog" ADD COLUMN "podId" TEXT,
ADD COLUMN "discardedAt" TIMESTAMP(3),
ADD COLUMN "discardReason" TEXT,
ADD COLUMN "recordingStatus" TEXT;
CREATE INDEX "CallLog_podId_startedAt_idx" ON "CallLog"("podId", "startedAt");
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_podId_fkey" FOREIGN KEY ("podId") REFERENCES "Pod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cold contacts: shared inbox (N025, B177), first real claim (B194), pusher's name (B205), possible
-- bounce (N097), where an opt-out came from and when it was lifted (D4), who removed it and why
-- (B086), the latest call outcome (D3), and a possible CRM match (B143).
ALTER TABLE "SandboxContact" ADD COLUMN "emailIsRole" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "firstClaimedAt" TIMESTAMP(3),
ADD COLUMN "pushedByName" TEXT,
ADD COLUMN "possibleBounceAt" TIMESTAMP(3),
ADD COLUMN "optOutSource" TEXT,
ADD COLUMN "optOutLiftedAt" TIMESTAMP(3),
ADD COLUMN "removedById" TEXT,
ADD COLUMN "removedReason" TEXT,
ADD COLUMN "lastOutcome" TEXT,
ADD COLUMN "lastOutcomeAt" TIMESTAMP(3),
ADD COLUMN "possibleCrmPersonId" TEXT;

-- Move to CRM and Undo (PLAN 8.6): the step applied only on success (B034), what to restore
-- (B097, B101), permanent failures (B105), the undo report (B113) and each item's own deadline (N062).
ALTER TABLE "SandboxMoveItem" ADD COLUMN "failure" TEXT,
ADD COLUMN "nextStep" JSONB,
ADD COLUMN "priorNextAction" JSONB,
ADD COLUMN "personNextBefore" JSONB,
ADD COLUMN "exitedEnrollmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "undoReport" JSONB,
ADD COLUMN "undoUntil" TIMESTAMP(3);

-- What a Bellwether refusal matched on, so a CRM opt-out never flips a shared line's (N011).
ALTER TABLE "BellwetherRefusal" ADD COLUMN "matchedOn" TEXT;

-- The CRM copy: normalised emails for every comparison (B011, B073), and its opt-out's origin (D4).
ALTER TABLE "PersonCache" ADD COLUMN "emailNorm" TEXT,
ADD COLUMN "additionalEmailsNorm" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "optedOutAt" TIMESTAMP(3),
ADD COLUMN "optOutSource" TEXT,
ADD COLUMN "optOutLiftedAt" TIMESTAMP(3);
CREATE INDEX "PersonCache_emailNorm_idx" ON "PersonCache"("emailNorm");
CREATE INDEX "PersonCache_additionalEmailsNorm_idx" ON "PersonCache" USING GIN ("additionalEmailsNorm");

-- Twenty's updatedAt after each of Cadence's writes, so Undo can tell them from a person's edit (B033).
ALTER TABLE "TwentyWrite" ADD COLUMN "resultUpdatedAt" TEXT;

-- Suppression: the one person a shared-line row protects, and the opt-out that wrote each row (PLAN
-- 8.2, D4). The unique key changes in 20261105000400_suppression_per_subject.
ALTER TABLE "Suppression" ADD COLUMN "subjectId" TEXT,
ADD COLUMN "source" TEXT;
CREATE INDEX "Suppression_valueHash_idx" ON "Suppression"("valueHash");
CREATE INDEX "Suppression_subjectId_idx" ON "Suppression"("subjectId");
CREATE INDEX "Suppression_sandboxContactId_idx" ON "Suppression"("sandboxContactId");
CREATE INDEX "Suppression_personId_idx" ON "Suppression"("personId");

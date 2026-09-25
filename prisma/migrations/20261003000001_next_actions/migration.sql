-- A person's next action outside any campaign, once or on repeat, tied to Twenty's Next Action Due Date.
CREATE TYPE "NextActionRepeat" AS ENUM ('NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY');
CREATE TYPE "NextActionState" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

CREATE TABLE "NextAction" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "foUserId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "action" "ActionType" NOT NULL DEFAULT 'EMAIL',
    "dueDate" TEXT NOT NULL,
    "repeat" "NextActionRepeat" NOT NULL DEFAULT 'NONE',
    "state" "NextActionState" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "completedById" TEXT,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "lastDoneAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "crmPending" BOOLEAN NOT NULL DEFAULT true,
    "crmSyncedAt" TIMESTAMP(3),
    "crmError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NextAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NextAction_foUserId_state_dueDate_idx" ON "NextAction"("foUserId", "state", "dueDate");
CREATE INDEX "NextAction_personId_state_idx" ON "NextAction"("personId", "state");
CREATE INDEX "NextAction_state_crmPending_idx" ON "NextAction"("state", "crmPending");
-- One open next action per person, as Twenty holds one.
CREATE UNIQUE INDEX "NextAction_one_open_per_person" ON "NextAction"("personId") WHERE "state" = 'OPEN';

ALTER TABLE "NextAction" ADD CONSTRAINT "NextAction_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NextAction" ADD CONSTRAINT "NextAction_foUserId_fkey" FOREIGN KEY ("foUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

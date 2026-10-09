-- The step an email or call counted for, so a touch is judged once and never re-tried.
ALTER TABLE "Touch" ADD COLUMN "countedForTaskId" TEXT;
CREATE INDEX "Touch_countedForTaskId_idx" ON "Touch"("countedForTaskId");
ALTER TABLE "Touch" ADD CONSTRAINT "Touch_countedForTaskId_fkey" FOREIGN KEY ("countedForTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Touches that already closed a step.
UPDATE "Touch" x SET "countedForTaskId" = t.id FROM "Task" t WHERE t."evidenceId" = x."externalId";

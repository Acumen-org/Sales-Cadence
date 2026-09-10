-- A failed write to Twenty used to be an audit row and nothing else. It is now a TwentyWrite in
-- status FAILED, which the worker retries with backoff and Settings lists with a Retry button.
ALTER TABLE "TwentyWrite"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OK',
  ADD COLUMN "error" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "TwentyWrite_status_nextAttemptAt_idx" ON "TwentyWrite"("status", "nextAttemptAt");

-- T32: indexes for lookups that had none: a pod's and a sequence's campaigns and enrollments, and
-- the hourly purge of expired sessions. Additive and idempotent; these tables are small, so the
-- builds are short, and the previous release runs unchanged with them.
CREATE INDEX IF NOT EXISTS "Campaign_podId_idx" ON "Campaign"("podId");
CREATE INDEX IF NOT EXISTS "Campaign_sequenceId_idx" ON "Campaign"("sequenceId");
CREATE INDEX IF NOT EXISTS "Enrollment_sequenceId_idx" ON "Enrollment"("sequenceId");
CREATE INDEX IF NOT EXISTS "Enrollment_podId_idx" ON "Enrollment"("podId");
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");

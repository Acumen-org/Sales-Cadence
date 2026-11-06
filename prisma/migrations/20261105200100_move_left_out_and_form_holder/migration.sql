-- Move to CRM keeps what it left out and why, for the move's own page (B186): [{ contactId, name, reason }].
ALTER TABLE "SandboxMove" ADD COLUMN IF NOT EXISTS "leftOut" JSONB NOT NULL DEFAULT '[]';
-- The rep's next step a move was asked for, when the dialog gave one: what contacts without a step of
-- their own get ({ label, action, dueDate }). Each item keeps the step it will apply (nextStep).
ALTER TABLE "SandboxMove" ADD COLUMN IF NOT EXISTS "nextStep" JSONB;
-- When the mover was told the move ended (B036), so they are told once.
ALTER TABLE "SandboxMove" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

-- Who fills a call's form when it is not the rep who made the call (N010): the replacement after the
-- rep's access was removed, or a colleague a leader handed it to. Null means the rep who made it.
-- The call itself keeps its rep, so past figures by rep never change.
ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "formUserId" TEXT;
CREATE INDEX IF NOT EXISTS "CallLog_formUserId_formDoneAt_idx" ON "CallLog" ("formUserId", "formDoneAt");

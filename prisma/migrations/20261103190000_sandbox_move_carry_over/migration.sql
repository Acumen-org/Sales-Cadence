-- Move to CRM carries a running sandbox campaign over to the person instead of ending it.
-- The move item records which enrollments carried over and which had to end, for Undo.
ALTER TABLE "SandboxMoveItem" ADD COLUMN "carryOver" JSONB;

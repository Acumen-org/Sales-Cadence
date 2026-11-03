-- Move to CRM: a process claims an item (state RUNNING) before it works it, so the web request
-- and the worker never process the same item. A claim older than ten minutes is taken back.
ALTER TABLE "SandboxMoveItem" ADD COLUMN "claimedAt" TIMESTAMP(3);

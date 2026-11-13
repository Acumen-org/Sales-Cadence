-- N28: a Next Action write the CRM keeps refusing backs off and is given up, instead of being sent
-- again every minute for ever. Additive and idempotent; an older app version ignores both columns.
ALTER TABLE "NextAction" ADD COLUMN IF NOT EXISTS "crmAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NextAction" ADD COLUMN IF NOT EXISTS "crmRetryAt" TIMESTAMP(3);

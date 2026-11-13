-- N12: CRM requests sent per minute, shared by the web app and the worker, so together they stay
-- under Twenty's allowance. Additive and idempotent; an older app version ignores it.
CREATE TABLE IF NOT EXISTS "CrmRequestBudget" (
    "minute" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CrmRequestBudget_pkey" PRIMARY KEY ("minute")
);

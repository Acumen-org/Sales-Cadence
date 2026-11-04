-- Daily check of sandbox contacts against Twenty (src/lib/sandbox/crm-check.ts): three optional
-- columns for the CRM person found after the push, whose outreach the check stopped.
-- Nullable only, so this applies to the live database with the app running.

-- AlterTable
ALTER TABLE "SandboxContact" ADD COLUMN "crmMatchPersonId" TEXT,
ADD COLUMN "crmMatchedOn" TEXT,
ADD COLUMN "crmMatchedAt" TIMESTAMP(3);

-- Sandbox CRM cleanup (docs/outreach-sandbox-plan.md, section 8.9): three optional columns on the
-- sandbox contact for a person Twenty's mail or calendar sync created and someone has since worked.
-- Nullable only, so this applies to the live database with the app running.

-- AlterTable
ALTER TABLE "SandboxContact" ADD COLUMN "crmAutoPersonId" TEXT,
ADD COLUMN "crmAutoSource" TEXT,
ADD COLUMN "crmAutoFlaggedAt" TIMESTAMP(3);

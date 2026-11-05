-- Audience stamping (PLAN 8.4, B037): every activity row records, once and for good, whether the work
-- was CRM outreach or cold outreach (SANDBOX, the code's name for it). Reports and Home count by it,
-- so a move to the CRM or an undo never rewrites the past. A task takes its enrollment's. Nullable:
-- rows from before the stamping code are classified by the next migration, and the columns become
-- NOT NULL in W14, except on CallLog, where null means "not matched to anyone yet". Nullable columns
-- and plain indexes only, so this applies to the live database with the app running.
ALTER TABLE "Touch" ADD COLUMN "audience" "CampaignAudience";
ALTER TABLE "CallLog" ADD COLUMN "audience" "CampaignAudience";
ALTER TABLE "NextAction" ADD COLUMN "audience" "CampaignAudience";
ALTER TABLE "Enrollment" ADD COLUMN "audience" "CampaignAudience";
ALTER TABLE "CallForm" ADD COLUMN "audience" "CampaignAudience";

CREATE INDEX "Touch_audience_occurredAt_idx" ON "Touch"("audience", "occurredAt");
CREATE INDEX "CallLog_audience_startedAt_idx" ON "CallLog"("audience", "startedAt");
CREATE INDEX "NextAction_audience_dueDate_idx" ON "NextAction"("audience", "dueDate");
CREATE INDEX "Enrollment_audience_createdAt_idx" ON "Enrollment"("audience", "createdAt");
CREATE INDEX "CallForm_audience_submittedAt_idx" ON "CallForm"("audience", "submittedAt");

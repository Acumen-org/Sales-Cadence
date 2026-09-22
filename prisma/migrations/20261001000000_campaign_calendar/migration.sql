ALTER TABLE "Sequence" ADD COLUMN "campaignOwned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "plannerDraft" JSONB, ADD COLUMN "publishedPlan" JSONB;
ALTER TABLE "Enrollment" ADD COLUMN "scheduleDates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DROP INDEX "Sequence_name_key";

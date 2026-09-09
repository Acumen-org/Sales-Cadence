ALTER TABLE "Campaign" ADD COLUMN "followupSourceRun" INTEGER;
UPDATE "Campaign" AS followup SET "followupSourceRun" = source."runNumber" FROM "Campaign" AS source WHERE followup."followupSourceId" = source.id;

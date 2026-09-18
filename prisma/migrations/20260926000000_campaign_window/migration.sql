-- A campaign runs between two dates (18 September 2026). The end date bounds when the last person
-- can start so that everyone finishes the sequence inside it; the planner derives the daily start
-- rate from it. Existing campaigns get an end date from their start and their plan's span, the old
-- ramp becomes the start rate, and "notes" becomes "description".
ALTER TABLE "Campaign" ADD COLUMN "endDate" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "startsPerFoPerDay" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "hardStopAtEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "productInterest" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Campaign" RENAME COLUMN "notes" TO "description";

UPDATE "Campaign" c
SET "startsPerFoPerDay" = c."dailyRampPerFo",
    "endDate" = to_char(
      to_date(c."startDate", 'YYYY-MM-DD') + COALESCE((SELECT s."durationDays" FROM "Sequence" s WHERE s.id = c."sequenceId"), 30) + 14,
      'YYYY-MM-DD'
    );

ALTER TABLE "Campaign" DROP COLUMN "dailyRampPerFo";

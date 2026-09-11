-- A sequence may repeat: after its last step it starts again N working days later as a new
-- enrollment (cycle 2, 3, ...), until the person replies, books or is removed.
ALTER TABLE "Sequence" ADD COLUMN "repeatEveryDays" INTEGER;
ALTER TABLE "Enrollment" ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1;

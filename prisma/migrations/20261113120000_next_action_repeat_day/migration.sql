-- P20: the day of the month a repeating next action was set for. Additive and nullable: older rows
-- (and the previous release) keep stepping from the due date itself.
ALTER TABLE "NextAction" ADD COLUMN IF NOT EXISTS "repeatDay" INTEGER;

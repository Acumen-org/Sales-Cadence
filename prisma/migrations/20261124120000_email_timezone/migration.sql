-- The time zone of each person's computer, for when their notification emails arrive (24 Nov 2026).
ALTER TABLE "User" ADD COLUMN "emailTimezone" TEXT;

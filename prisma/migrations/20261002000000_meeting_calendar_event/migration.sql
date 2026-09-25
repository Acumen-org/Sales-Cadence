-- A meeting Cadence made from a calendar event Twenty synced: the event it came from, so a
-- reschedule, a cancellation or a new guest updates the same meeting instead of adding one.
ALTER TABLE "Meeting" ADD COLUMN "calendarEventId" TEXT;
CREATE UNIQUE INDEX "Meeting_calendarEventId_key" ON "Meeting"("calendarEventId");

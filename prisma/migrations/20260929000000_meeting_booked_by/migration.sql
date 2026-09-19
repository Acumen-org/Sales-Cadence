-- The FO who booked the meeting: mandatory on a new meeting, set on older ones when edited.
ALTER TABLE "Meeting" ADD COLUMN "bookedById" TEXT;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Meeting_bookedById_idx" ON "Meeting"("bookedById");

-- Starred meetings, per user.
CREATE TABLE "MeetingFavourite" (
    "userId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeetingFavourite_pkey" PRIMARY KEY ("userId","meetingId")
);
CREATE INDEX "MeetingFavourite_meetingId_idx" ON "MeetingFavourite"("meetingId");
ALTER TABLE "MeetingFavourite" ADD CONSTRAINT "MeetingFavourite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingFavourite" ADD CONSTRAINT "MeetingFavourite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

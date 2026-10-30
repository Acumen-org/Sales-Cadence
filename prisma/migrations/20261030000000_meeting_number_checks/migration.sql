-- "Think this is wrong?" on a meeting number (owner, 30 October 2026): a ticket Biz Ops checks, and
-- the number they set on a meeting when it was wrong.
ALTER TABLE "MeetingAttendee" ADD COLUMN "numberSetTo" INTEGER;

CREATE TABLE "MeetingNumberTicket" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "meetingId" TEXT,
    "meetingDay" TEXT NOT NULL,
    "shownNumber" INTEGER NOT NULL,
    "expectedNumber" INTEGER,
    "note" TEXT,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "raisedById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeetingNumberTicket_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MeetingNumberTicket_open_createdAt_idx" ON "MeetingNumberTicket"("open", "createdAt");
CREATE INDEX "MeetingNumberTicket_personId_idx" ON "MeetingNumberTicket"("personId");
ALTER TABLE "MeetingNumberTicket" ADD CONSTRAINT "MeetingNumberTicket_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingNumberTicket" ADD CONSTRAINT "MeetingNumberTicket_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MeetingNumberTicket" ADD CONSTRAINT "MeetingNumberTicket_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MeetingNumberTicket" ADD CONSTRAINT "MeetingNumberTicket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

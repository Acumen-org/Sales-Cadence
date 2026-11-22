-- Owner, 21 Nov 2026: a colleague's 👏 on a booked meeting, and the bell by email.

ALTER TABLE "User" ADD COLUMN "emailNotifications" TEXT NOT NULL DEFAULT 'smart';
ALTER TABLE "User" ADD COLUMN "lastDigestOn" TEXT;

ALTER TABLE "Notification" ADD COLUMN "emailedAt" TIMESTAMP(3);
-- Everything already in a bell was seen there or is old news: never emailed.
UPDATE "Notification" SET "emailedAt" = CURRENT_TIMESTAMP WHERE "emailedAt" IS NULL;
CREATE INDEX "Notification_emailedAt_createdAt_idx" ON "Notification"("emailedAt", "createdAt");

CREATE TABLE "MeetingKudos" (
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeetingKudos_pkey" PRIMARY KEY ("meetingId","userId")
);
CREATE INDEX "MeetingKudos_userId_idx" ON "MeetingKudos"("userId");
ALTER TABLE "MeetingKudos" ADD CONSTRAINT "MeetingKudos_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingKudos" ADD CONSTRAINT "MeetingKudos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "notificationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationEmail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NotificationEmail_userId_createdAt_idx" ON "NotificationEmail"("userId", "createdAt");
CREATE INDEX "NotificationEmail_status_createdAt_idx" ON "NotificationEmail"("status", "createdAt");
ALTER TABLE "NotificationEmail" ADD CONSTRAINT "NotificationEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tickets (D4, owner, 5 November 2026): a general ticket Biz Ops look into and close with a note,
-- built like MeetingNumberTicket, which sits beside it in the same Tickets section and can be folded
-- in as kind MEETING_NUMBER. First kind: "Think this is wrong?" on an opt-out from the post-call form.
-- Notifications (PLAN 8.12): what one user is told about that is not a reply, such as a colleague's
-- suggested next step (B027) or mail seen to an opted-out contact (N016). New tables only, so this
-- applies to the live database with the app running.
CREATE TYPE "TicketKind" AS ENUM ('OPT_OUT', 'MEETING_NUMBER');

CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "kind" "TicketKind" NOT NULL,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "meetingId" TEXT,
    "note" TEXT,
    "details" JSONB,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "raisedById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Ticket_open_createdAt_idx" ON "Ticket"("open", "createdAt");
CREATE INDEX "Ticket_kind_open_idx" ON "Ticket"("kind", "open");
CREATE INDEX "Ticket_personId_idx" ON "Ticket"("personId");
CREATE INDEX "Ticket_sandboxContactId_idx" ON "Ticket"("sandboxContactId");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_personId_fkey" FOREIGN KEY ("personId") REFERENCES "PersonCache"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sandboxContactId_fkey" FOREIGN KEY ("sandboxContactId") REFERENCES "SandboxContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "personId" TEXT,
    "sandboxContactId" TEXT,
    "fromUserId" TEXT,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

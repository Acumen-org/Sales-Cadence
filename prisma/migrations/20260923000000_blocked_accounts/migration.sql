-- Accounts an admin has taken out of the platform. The CRM record is never touched: this is a
-- list of ids Cadence refuses to show or work, so unblocking puts the account back as it was.
CREATE TABLE "BlockedAccount" (
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "reason" TEXT,
    "blockedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedAccount_pkey" PRIMARY KEY ("companyId")
);
CREATE INDEX "BlockedAccount_createdAt_idx" ON "BlockedAccount"("createdAt");
ALTER TABLE "BlockedAccount" ADD CONSTRAINT "BlockedAccount_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

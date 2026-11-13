-- Q14: a removed person is marked on their row, not only in the audit log. Additive; the previous
-- app version ignores the column.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accessRemovedAt" TIMESTAMP(3);

-- Everyone inactive whose newest access row says "removed" is marked removed at that time.
UPDATE "User" u
SET "accessRemovedAt" = last."createdAt"
FROM (
  SELECT DISTINCT ON ("entityId") "entityId", "action", "createdAt"
  FROM "AuditLog"
  WHERE "entityType" = 'user' AND "action" IN ('created', 'enabled', 'removed', 'restored')
  ORDER BY "entityId", "createdAt" DESC
) last
WHERE last."entityId" = u."id" AND last."action" = 'removed' AND u."active" = false AND u."accessRemovedAt" IS NULL;

-- Q02/Q03/Q08/Q09: password sign-in attempts, counted per address and per caller address.
CREATE TABLE IF NOT EXISTS "SignInAttempt" (
    "id" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignInAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SignInAttempt_email_createdAt_idx" ON "SignInAttempt"("email", "createdAt");
CREATE INDEX IF NOT EXISTS "SignInAttempt_ip_createdAt_idx" ON "SignInAttempt"("ip", "createdAt");

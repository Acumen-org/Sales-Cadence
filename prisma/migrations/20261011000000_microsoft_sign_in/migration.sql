-- Microsoft sign-in: who signs in with which Microsoft account, and who still waits for a title.
ALTER TABLE "User" ADD COLUMN "roleAssigned" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "microsoftId" TEXT;
CREATE UNIQUE INDEX "User_microsoftId_key" ON "User"("microsoftId");

-- acumen-talent.com is one of our own domains too (owner, 9 October 2026).
UPDATE "Setting"
SET "value" = jsonb_set("value", '{internalDomains}', ("value"->'internalDomains') || '["acumen-talent.com"]'::jsonb), "updatedAt" = now()
WHERE "key" = 'rules'
  AND jsonb_typeof("value"->'internalDomains') = 'array'
  AND NOT ("value"->'internalDomains' @> '["acumen-talent.com"]'::jsonb);

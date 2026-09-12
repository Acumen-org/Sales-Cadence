-- Nameless records sort last, not first.
ALTER TABLE "PersonCache" ADD COLUMN "sortName" TEXT;
ALTER TABLE "CompanyCache" ADD COLUMN "sortName" TEXT;
UPDATE "PersonCache" SET "sortName" = NULLIF(lower(trim(both from "lastName" || ' ' || "firstName")), '');
UPDATE "CompanyCache" SET "sortName" = NULLIF(lower(trim(both from "name")), '');
CREATE INDEX "PersonCache_sortName_idx" ON "PersonCache"("sortName");
CREATE INDEX "CompanyCache_sortName_idx" ON "CompanyCache"("sortName");

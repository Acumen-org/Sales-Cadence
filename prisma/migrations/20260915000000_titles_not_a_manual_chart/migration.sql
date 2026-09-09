-- The account relationship view groups people by the job title Twenty already holds, so the
-- hand-maintained chart is gone: nobody could keep a reporting line or a "stance" honest, and
-- with the editor removed these three columns could only ever hold seeded data.
DROP INDEX IF EXISTS "PersonCache_reportsToId_idx";
ALTER TABLE "PersonCache" DROP COLUMN IF EXISTS "reportsToId";
ALTER TABLE "PersonCache" DROP COLUMN IF EXISTS "accountRole";
ALTER TABLE "PersonCache" DROP COLUMN IF EXISTS "relationshipNote";
DROP TYPE IF EXISTS "AccountRole";

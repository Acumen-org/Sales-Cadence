-- A/B template variants and either/or alternate actions are gone. A step now holds as many
-- modules as it needs (a call and its follow-up email are one step), which is the same idea
-- expressed once instead of three times.
DROP INDEX IF EXISTS "Task_variantId_idx";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "variantId";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "altAction";

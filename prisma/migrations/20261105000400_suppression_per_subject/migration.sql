-- Suppression rows for one person (PLAN 8.2, B001, B018, N011). A firm main, office or unknown line
-- is suppressed for the one person who opted out (kind phone_subject, with subjectId), so a shared
-- line never opts out a colleague, and two colleagues opted out over the same line each keep their
-- own row. The single unique key (kind, valueHash) becomes two partial ones: one row per value for
-- the rows that protect whoever holds the value (subjectId null, every row today), and one row per
-- value and person for the rest. Every existing row has subjectId null and was already unique on
-- (kind, valueHash), so the new index cannot fail; both happen in this one transaction, so there is
-- no moment without a key.
DROP INDEX IF EXISTS "Suppression_kind_valueHash_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Suppression_global_key" ON "Suppression"("kind", "valueHash") WHERE "subjectId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Suppression_subject_key" ON "Suppression"("kind", "valueHash", "subjectId") WHERE "subjectId" IS NOT NULL;

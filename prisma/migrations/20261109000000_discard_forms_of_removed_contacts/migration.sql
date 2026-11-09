-- Owner, 9 Nov 2026: a removed or erased cold contact's calls no longer wait for a form. Removing a
-- contact now discards them (src/lib/outreach/transitions.ts); this puts right the calls left waiting
-- by removals made before that. Idempotent: a second run finds nothing.
UPDATE "CallLog" l
SET "discardedAt" = now() AT TIME ZONE 'UTC',
    "discardReason" = 'The contact was removed, so the call needs no form.'
FROM "SandboxContact" c
WHERE l."sandboxContactId" = c."id"
  AND l."personId" IS NULL
  AND l."formDueAt" IS NOT NULL
  AND l."formDoneAt" IS NULL
  AND l."discardedAt" IS NULL
  AND (c."status"::text = 'REMOVED' OR c."erasedAt" IS NOT NULL);

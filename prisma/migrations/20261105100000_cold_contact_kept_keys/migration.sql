-- A tombstone keeps its keys as hashes (N027). Remove and retention clear a cold contact's personal
-- data, which used to leave nothing to suppress if the person later asked not to be contacted:
-- Bellwether then sent them straight back. Each key is kept the way the suppression list keeps it
-- (kind, SHA-256 of the normalised value, the masked label, and the one person a shared line
-- protects), never the value itself. Additive, with a default, so it cannot fail on existing rows.
ALTER TABLE "SandboxContact" ADD COLUMN IF NOT EXISTS "keptKeys" JSONB NOT NULL DEFAULT '[]';

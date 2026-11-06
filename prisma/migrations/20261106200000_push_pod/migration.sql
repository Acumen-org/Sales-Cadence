-- From Bellwether (S10): the pod a push is for, so leaders see their pods' pushes. Additive; older
-- pushes keep NULL and are scoped by their pusher's pods when read.
ALTER TABLE "BellwetherPush" ADD COLUMN IF NOT EXISTS "podId" TEXT;
CREATE INDEX IF NOT EXISTS "BellwetherPush_podId_createdAt_idx" ON "BellwetherPush"("podId", "createdAt");

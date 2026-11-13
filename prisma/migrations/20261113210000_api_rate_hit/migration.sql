-- U19, U27, V09: the integration and read API limits are counted here, shared by every server
-- process and kept across restarts: one row per request in the last minute, per key and (for wrong
-- keys) per caller. Additive and idempotent; an older app version ignores it.
CREATE TABLE IF NOT EXISTS "ApiRateHit" (
    "id" BIGSERIAL NOT NULL,
    "bucket" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiRateHit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ApiRateHit_bucket_at_idx" ON "ApiRateHit" ("bucket", "at");

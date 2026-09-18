-- A note on one missing field of one record: who is researching it, or that it could not be found.
CREATE TABLE "EnrichmentMark" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "assigneeId" TEXT,
    "note" TEXT,
    "byId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrichmentMark_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnrichmentMark_entity_recordId_field_key" ON "EnrichmentMark"("entity", "recordId", "field");
CREATE INDEX "EnrichmentMark_assigneeId_idx" ON "EnrichmentMark"("assigneeId");
ALTER TABLE "EnrichmentMark" ADD CONSTRAINT "EnrichmentMark_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One field's completeness for one group on one day, so the scorecard shows trend.
CREATE TABLE "EnrichmentSnapshot" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "groupKind" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "filled" INTEGER NOT NULL,
    CONSTRAINT "EnrichmentSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnrichmentSnapshot_day_entity_groupKind_groupId_field_key" ON "EnrichmentSnapshot"("day", "entity", "groupKind", "groupId", "field");
CREATE INDEX "EnrichmentSnapshot_day_idx" ON "EnrichmentSnapshot"("day");

-- The column mapping last used for a file with these headers.
CREATE TABLE "EnrichmentMapping" (
    "signature" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EnrichmentMapping_pkey" PRIMARY KEY ("signature")
);

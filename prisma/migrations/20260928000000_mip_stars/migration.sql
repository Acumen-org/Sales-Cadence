-- How much a most-important person matters to the pod: one to three stars, set by the pod itself.
CREATE TABLE "MipStars" (
    "personId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MipStars_pkey" PRIMARY KEY ("personId")
);
ALTER TABLE "MipStars" ADD CONSTRAINT "MipStars_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

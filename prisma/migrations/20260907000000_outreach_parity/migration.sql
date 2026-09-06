-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "disposition" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "PersonCache" ADD COLUMN     "badEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "badPhone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "optedOut" BOOLEAN NOT NULL DEFAULT false;


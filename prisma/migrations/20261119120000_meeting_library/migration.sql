-- Meeting recordings copied into the company's Meeting Recordings library, and meetings marked as not recorded.
ALTER TABLE "Meeting" ADD COLUMN "notRecorded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN "libraryStatus" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryError" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryTries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Meeting" ADD COLUMN "libraryNextAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "libraryMonitorUrl" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryItemId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryUrl" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryEmbedUrl" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "libraryCopiedAt" TIMESTAMP(3);

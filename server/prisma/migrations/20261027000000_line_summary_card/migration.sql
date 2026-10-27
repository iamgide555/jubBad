-- AlterTable
ALTER TABLE "Group" ADD COLUMN "lineSummaryDefault" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "lineSummarySentAt" DATETIME;

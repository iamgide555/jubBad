-- AlterTable
ALTER TABLE "Group" ADD COLUMN "lineDmEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LineUserLinkCode" ADD COLUMN "groupCode" TEXT;

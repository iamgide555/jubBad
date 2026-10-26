-- AlterTable
ALTER TABLE "Group" ADD COLUMN "lineGroupId" TEXT;
ALTER TABLE "Group" ADD COLUMN "lineGroupName" TEXT;
ALTER TABLE "Group" ADD COLUMN "lineLeftAt" DATETIME;
ALTER TABLE "Group" ADD COLUMN "lineLinkedAt" DATETIME;

-- CreateTable
CREATE TABLE "LineLinkCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineLinkCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LineRosterMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderName" TEXT,
    "postedAt" DATETIME NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "botPosted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineRosterMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LineLinkCode_codeHash_key" ON "LineLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "LineLinkCode_groupId_idx" ON "LineLinkCode"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "LineRosterMessage_lineMessageId_key" ON "LineRosterMessage"("lineMessageId");

-- CreateIndex
CREATE INDEX "LineRosterMessage_groupId_postedAt_idx" ON "LineRosterMessage"("groupId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Group_lineGroupId_key" ON "Group"("lineGroupId");


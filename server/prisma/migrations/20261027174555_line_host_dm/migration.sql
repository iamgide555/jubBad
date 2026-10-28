/*
  Warnings:

  - A unique constraint covering the columns `[lineUserId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "lineLinkedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "lineUserId" TEXT;

-- CreateTable
CREATE TABLE "LineUserLinkCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineUserLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LinePendingRoster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinePendingRoster_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "LineRosterMessage" ADD COLUMN "direct" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "LineUserLinkCode_codeHash_key" ON "LineUserLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "LineUserLinkCode_userId_idx" ON "LineUserLinkCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LinePendingRoster_userId_key" ON "LinePendingRoster"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");

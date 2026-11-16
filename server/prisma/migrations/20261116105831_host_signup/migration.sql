-- Added in place, not by rebuilding "User": a rebuild drops the table, and a runner that applies this inside a
-- transaction with foreign keys on would then cascade through Group.ownerId and PasswordReset. The earlier
-- plan / lineUserId columns were added this way too.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "signupSource" TEXT NOT NULL DEFAULT 'admin';

-- CreateTable
CREATE TABLE "TrialRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineUserId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrialRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TrialRecord_lineUserId_key" ON "TrialRecord"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TrialRecord_userId_key" ON "TrialRecord"("userId");

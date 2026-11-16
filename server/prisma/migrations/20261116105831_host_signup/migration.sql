-- CreateTable
CREATE TABLE "TrialRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineUserId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrialRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'host',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'club',
    "planRenewsAt" DATETIME,
    "lineUserId" TEXT,
    "lineLinkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signupSource" TEXT NOT NULL DEFAULT 'admin'
);
INSERT INTO "new_User" ("createdAt", "disabled", "email", "id", "lineLinkedAt", "lineUserId", "passwordHash", "plan", "planRenewsAt", "role", "tokenVersion") SELECT "createdAt", "disabled", "email", "id", "lineLinkedAt", "lineUserId", "passwordHash", "plan", "planRenewsAt", "role", "tokenVersion" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TrialRecord_lineUserId_key" ON "TrialRecord"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TrialRecord_userId_key" ON "TrialRecord"("userId");

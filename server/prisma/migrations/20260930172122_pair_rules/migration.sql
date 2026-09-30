-- AlterTable
ALTER TABLE "Session" ADD COLUMN "disabledRuleIds" TEXT DEFAULT '[]';

-- CreateTable
CREATE TABLE "PlayerRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "playerAId" TEXT NOT NULL,
    "playerBId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlayerRule_playerAId_fkey" FOREIGN KEY ("playerAId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlayerRule_playerBId_fkey" FOREIGN KEY ("playerBId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Pairing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "courtNumber" INTEGER NOT NULL,
    "matchNumber" INTEGER NOT NULL,
    "teamA" TEXT NOT NULL,
    "teamB" TEXT NOT NULL,
    "scoreA" INTEGER,
    "scoreB" INTEGER,
    "winner" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "pendingSince" DATETIME,
    "shownSplits" TEXT NOT NULL DEFAULT '[]',
    "confirmedAt" DATETIME,
    "endedAt" DATETIME,
    "carryOutcomes" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "Pairing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pairing" ("confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "shownSplits", "teamA", "teamB", "winner") SELECT "confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "shownSplits", "teamA", "teamB", "winner" FROM "Pairing";
DROP TABLE "Pairing";
ALTER TABLE "new_Pairing" RENAME TO "Pairing";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PlayerRule_groupId_playerAId_playerBId_key" ON "PlayerRule"("groupId", "playerAId", "playerBId");

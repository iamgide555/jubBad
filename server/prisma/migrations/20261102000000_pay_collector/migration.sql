-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Group" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT,
    "shuttleToolsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "crossSessionHistory" BOOLEAN NOT NULL DEFAULT false,
    "levelLadder" TEXT,
    "levelLadderRevision" INTEGER NOT NULL DEFAULT 0,
    "shareToken" TEXT,
    "lineGroupId" TEXT,
    "lineGroupName" TEXT,
    "lineLinkedAt" DATETIME,
    "lineLeftAt" DATETIME,
    "lineSummaryDefault" BOOLEAN NOT NULL DEFAULT true,
    "lineDmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payAccount" TEXT,
    "payCollectorPlayerId" TEXT,
    CONSTRAINT "Group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Group_payCollectorPlayerId_fkey" FOREIGN KEY ("payCollectorPlayerId") REFERENCES "Player" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Group" ("code", "createdAt", "crossSessionHistory", "levelLadder", "levelLadderRevision", "lineDmEnabled", "lineGroupId", "lineGroupName", "lineLeftAt", "lineLinkedAt", "lineSummaryDefault", "name", "ownerId", "payAccount", "shareToken", "shuttleToolsEnabled") SELECT "code", "createdAt", "crossSessionHistory", "levelLadder", "levelLadderRevision", "lineDmEnabled", "lineGroupId", "lineGroupName", "lineLeftAt", "lineLinkedAt", "lineSummaryDefault", "name", "ownerId", "payAccount", "shareToken", "shuttleToolsEnabled" FROM "Group";
DROP TABLE "Group";
ALTER TABLE "new_Group" RENAME TO "Group";
CREATE UNIQUE INDEX "Group_shareToken_key" ON "Group"("shareToken");
CREATE UNIQUE INDEX "Group_lineGroupId_key" ON "Group"("lineGroupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

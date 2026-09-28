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
    CONSTRAINT "Pairing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pairing" ("confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "teamA", "teamB", "winner") SELECT "confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "teamA", "teamB", "winner" FROM "Pairing";
DROP TABLE "Pairing";
ALTER TABLE "new_Pairing" RENAME TO "Pairing";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

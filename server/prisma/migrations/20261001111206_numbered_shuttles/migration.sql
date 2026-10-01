-- CreateTable
CREATE TABLE "SessionShuttle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "usable" BOOLEAN NOT NULL DEFAULT true,
    "voidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionShuttle_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PairingShuttleUse" (
    "pairingId" TEXT NOT NULL,
    "shuttleId" TEXT NOT NULL,

    PRIMARY KEY ("pairingId", "shuttleId"),
    CONSTRAINT "PairingShuttleUse_pairingId_fkey" FOREIGN KEY ("pairingId") REFERENCES "Pairing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PairingShuttleUse_shuttleId_fkey" FOREIGN KEY ("shuttleId") REFERENCES "SessionShuttle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "shuttleLogKnown" BOOLEAN NOT NULL DEFAULT false,
    "lastShuttleId" TEXT,
    CONSTRAINT "Pairing_lastShuttleId_fkey" FOREIGN KEY ("lastShuttleId") REFERENCES "SessionShuttle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Pairing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pairing" ("carryOutcomes", "confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "shownSplits", "teamA", "teamB", "winner") SELECT "carryOutcomes", "confirmedAt", "courtNumber", "endedAt", "id", "matchNumber", "pendingSince", "revision", "scoreA", "scoreB", "sessionId", "shownSplits", "teamA", "teamB", "winner" FROM "Pairing";
DROP TABLE "Pairing";
ALTER TABLE "new_Pairing" RENAME TO "Pairing";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SessionShuttle_sessionId_number_key" ON "SessionShuttle"("sessionId", "number");

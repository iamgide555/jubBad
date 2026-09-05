-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SessionRoster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SessionRoster_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SessionRoster" ("id", "playerId", "sessionId") SELECT "id", "playerId", "sessionId" FROM "SessionRoster";
DROP TABLE "SessionRoster";
ALTER TABLE "new_SessionRoster" RENAME TO "SessionRoster";
CREATE UNIQUE INDEX "SessionRoster_sessionId_playerId_key" ON "SessionRoster"("sessionId", "playerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

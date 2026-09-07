-- Add player foreign keys to roster references and persist a request key for
-- session creation retries. Existing rows are copied unchanged.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_SessionRoster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "gamesOffset" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" DATETIME,
    CONSTRAINT "SessionRoster_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SessionRoster_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SessionRoster" ("active", "activatedAt", "gamesOffset", "id", "playerId", "sessionId")
SELECT "active", "activatedAt", "gamesOffset", "id", "playerId", "sessionId" FROM "SessionRoster";
DROP TABLE "SessionRoster";
ALTER TABLE "new_SessionRoster" RENAME TO "SessionRoster";
CREATE UNIQUE INDEX "SessionRoster_sessionId_playerId_key" ON "SessionRoster"("sessionId", "playerId");

CREATE TABLE "new_Waitlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "Waitlist_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Waitlist_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Waitlist" ("id", "playerId", "position", "sessionId")
SELECT "id", "playerId", "position", "sessionId" FROM "Waitlist";
DROP TABLE "Waitlist";
ALTER TABLE "new_Waitlist" RENAME TO "Waitlist";
CREATE UNIQUE INDEX "Waitlist_sessionId_playerId_key" ON "Waitlist"("sessionId", "playerId");

CREATE TABLE "SessionCreation" (
    "groupId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("groupId", "idempotencyKey"),
    CONSTRAINT "SessionCreation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionCreation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SessionCreation_sessionId_key" ON "SessionCreation"("sessionId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

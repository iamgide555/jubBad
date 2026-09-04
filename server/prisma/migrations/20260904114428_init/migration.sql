-- CreateTable
CREATE TABLE "Group" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT NOT NULL,
    CONSTRAINT "Player_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "date" TEXT,
    "venue" TEXT,
    "courtCount" INTEGER,
    "rawImportText" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionRoster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    CONSTRAINT "SessionRoster_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Waitlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "Waitlist_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Pairing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "courtNumber" INTEGER NOT NULL,
    "matchNumber" INTEGER NOT NULL,
    "teamA" TEXT NOT NULL,
    "teamB" TEXT NOT NULL,
    "scoreA" INTEGER,
    "scoreB" INTEGER,
    "confirmedAt" DATETIME,
    "endedAt" DATETIME,
    CONSTRAINT "Pairing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionRoster_sessionId_playerId_key" ON "SessionRoster"("sessionId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_sessionId_playerId_key" ON "Waitlist"("sessionId", "playerId");

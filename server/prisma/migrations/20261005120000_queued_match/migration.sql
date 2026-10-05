-- Host-set lineups waiting for a free court. New table only, no redefines.
CREATE TABLE "QueuedMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "teamA" TEXT NOT NULL,
    "teamB" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueuedMatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "QueuedMatch_sessionId_position_idx" ON "QueuedMatch"("sessionId", "position");

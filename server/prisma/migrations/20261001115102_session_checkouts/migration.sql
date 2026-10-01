-- CreateTable
CREATE TABLE "SessionCheckout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "breakdown" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "settledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" DATETIME,
    "idempotencyKey" TEXT NOT NULL,
    CONSTRAINT "SessionCheckout_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SessionCheckout_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionCheckout_sessionId_playerId_idx" ON "SessionCheckout"("sessionId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionCheckout_sessionId_idempotencyKey_key" ON "SessionCheckout"("sessionId", "idempotencyKey");

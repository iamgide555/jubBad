-- A court can have at most one proposal or active match. Finished matches
-- remain available for history and undo.
CREATE UNIQUE INDEX "Pairing_sessionId_courtNumber_open_key"
ON "Pairing"("sessionId", "courtNumber")
WHERE "endedAt" IS NULL;

ALTER TABLE "Pairing" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

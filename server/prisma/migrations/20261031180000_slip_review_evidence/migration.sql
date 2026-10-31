ALTER TABLE "Session" ADD COLUMN "paymentCollectionClosedAt" DATETIME;
ALTER TABLE "PendingSlip" ADD COLUMN "reviewedAmountSatang" INTEGER;
ALTER TABLE "PendingSlip" ADD COLUMN "reviewedAt" DATETIME;

CREATE TABLE "SlipImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "SlipImage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SlipImage_sessionId_reference_key" ON "SlipImage"("sessionId", "reference");
CREATE INDEX "SlipImage_expiresAt_idx" ON "SlipImage"("expiresAt");

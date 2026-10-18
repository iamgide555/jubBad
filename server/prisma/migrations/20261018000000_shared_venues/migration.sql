-- Shared venue list. Nullable add only (no table rebuild, no backfill): existing
-- sessions keep their venue text and a NULL venueId.
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "Venue_normalizedName_key" ON "Venue"("normalizedName");

ALTER TABLE "Session" ADD COLUMN "venueId" TEXT REFERENCES "Venue" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

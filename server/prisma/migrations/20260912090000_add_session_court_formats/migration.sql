-- Per-court doubles/singles format, JSON-encoded string array, null on every
-- existing row (reads as all-doubles — see server/src/sessions/court-formats.ts).
ALTER TABLE "Session" ADD COLUMN "courtFormats" TEXT;

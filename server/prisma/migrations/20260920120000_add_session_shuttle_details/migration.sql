-- Shuttle count and price-per-shuttle (satang), null on every existing row
-- (reads as "not recorded" — see server/src/sessions/sessions.service.ts
-- setShuttleDetails).
ALTER TABLE "Session" ADD COLUMN "shuttleCount" INTEGER;
ALTER TABLE "Session" ADD COLUMN "shuttlePriceSatang" INTEGER;

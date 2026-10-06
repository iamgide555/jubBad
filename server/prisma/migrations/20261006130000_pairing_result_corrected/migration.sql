-- Marks a finished game whose winner/score the host corrected afterwards. Nullable add only.
ALTER TABLE "Pairing" ADD COLUMN "resultCorrectedAt" DATETIME;

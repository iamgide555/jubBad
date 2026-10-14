ALTER TABLE "Session" ADD COLUMN "closedAsForgottenAt" DATETIME;
ALTER TABLE "Pairing" ADD COLUMN "closedWithoutResultAt" DATETIME;
ALTER TABLE "Pairing" ADD COLUMN "estimatedDurationSeconds" INTEGER;

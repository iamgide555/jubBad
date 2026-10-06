-- Per-court Low/High target for level-mode courts. Nullable add only; null reads as auto.
ALTER TABLE "Session" ADD COLUMN "courtTargets" TEXT;

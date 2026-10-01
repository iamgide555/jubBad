-- Group-owned level ladders (host feedback F).
--
-- Plain ADD COLUMNs rather than a Prisma table redefine on purpose: a redefine
-- of "Group" copies only the columns this migration knows about and would drop
-- any column another migration (e.g. the shuttle-tools flags) added to the same
-- table before it.
ALTER TABLE "Group" ADD COLUMN "levelLadder" TEXT;
ALTER TABLE "Group" ADD COLUMN "levelLadderRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "levelSeed" INTEGER;

-- Freeze every existing player's rating anchor at what the built-in ladder gave
-- them until now: BG..B -> 900..1600, anything else (untagged, or an
-- unrecognised label) -> 1200. levelSetAt is deliberately left untouched, so a
-- player tagged "from the start" keeps a NULL timestamp and a previously
-- cleared one keeps their dated 1200 anchor; rating replay is unchanged.
UPDATE "Player" SET "levelSeed" = CASE "level"
  WHEN 'BG' THEN 900
  WHEN 'N'  THEN 1000
  WHEN 'S'  THEN 1100
  WHEN 'P-' THEN 1200
  WHEN 'P'  THEN 1300
  WHEN 'P+' THEN 1400
  WHEN 'C'  THEN 1500
  WHEN 'B'  THEN 1600
  ELSE 1200
END;

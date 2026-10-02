-- Public group dashboard credential. Plain ADD COLUMN + index, not a table
-- redefine: a redefine of "Group" would drop any column another migration
-- added to it.
ALTER TABLE "Group" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "Group_shareToken_key" ON "Group"("shareToken");

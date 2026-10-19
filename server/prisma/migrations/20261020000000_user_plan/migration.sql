-- Plan gating fields on the group owner. Plain ADD COLUMN, not a table
-- redefine: a redefine of "User" would drop any column another migration
-- added to it. The 'club' default keeps every existing user ungated.
ALTER TABLE "User" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'club';
ALTER TABLE "User" ADD COLUMN "planRenewsAt" DATETIME;

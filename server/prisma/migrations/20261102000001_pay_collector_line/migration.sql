-- AlterTable
ALTER TABLE "Group" ADD COLUMN "payCollectorLineUserId" TEXT;

-- CreateIndex
CREATE INDEX "Group_payCollectorPlayerId_idx" ON "Group"("payCollectorPlayerId");

/*
  Warnings:

  - You are about to drop the column `epcId` on the `ActivityLog` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "ActivityLog_epcId_idx";

-- AlterTable
ALTER TABLE "ActivityLog" DROP COLUMN "epcId";

-- CreateIndex
CREATE INDEX "ActivityLog_subjectId_idx" ON "ActivityLog"("subjectId");

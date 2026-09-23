/*
  Warnings:

  - You are about to drop the column `expected_revenue` on the `EPF` table. All the data in the column will be lost.
  - You are about to drop the column `total_budget` on the `EPF` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EPF" DROP COLUMN "expected_revenue",
DROP COLUMN "total_budget",
ADD COLUMN     "annualBudget" DECIMAL(12,2),
ADD COLUMN     "availableBudget" DECIMAL(12,2),
ADD COLUMN     "dealerName" TEXT,
ADD COLUMN     "dealerPercent" INTEGER,
ADD COLUMN     "dealerShare" INTEGER,
ADD COLUMN     "eventBudget" DECIMAL(12,2),
ADD COLUMN     "externalParticipants" INTEGER,
ADD COLUMN     "internalParticipants" INTEGER,
ADD COLUMN     "status" TEXT,
ADD COLUMN     "tataHitachiPoAmount" INTEGER;

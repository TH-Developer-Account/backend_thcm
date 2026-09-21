/*
  Warnings:

  - You are about to drop the column `dealerUserId` on the `DealerAuditInstance` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[businessPartnerId,officeType,periodLabel]` on the table `DealerAuditInstance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `businessPartnerId` to the `DealerAuditInstance` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "DealerAuditInstance" DROP CONSTRAINT "DealerAuditInstance_dealerUserId_fkey";

-- DropIndex
DROP INDEX "DealerAuditInstance_dealerUserId_officeType_periodLabel_key";

-- AlterTable
ALTER TABLE "AuditItemResponse" ADD COLUMN     "respondedByUserId" TEXT;

-- AlterTable
ALTER TABLE "DealerAuditInstance" DROP COLUMN "dealerUserId",
ADD COLUMN     "businessPartnerId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DealerAuditInstance_businessPartnerId_officeType_periodLabe_key" ON "DealerAuditInstance"("businessPartnerId", "officeType", "periodLabel");

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_businessPartnerId_fkey" FOREIGN KEY ("businessPartnerId") REFERENCES "BusinessPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditItemResponse" ADD CONSTRAINT "AuditItemResponse_respondedByUserId_fkey" FOREIGN KEY ("respondedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

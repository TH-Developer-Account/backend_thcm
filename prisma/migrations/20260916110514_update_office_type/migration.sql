/*
  Warnings:

  - Changed the type of `officeType` on the `ChecklistTemplate` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `officeType` on the `DealerAuditInstance` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "ChecklistTemplate" DROP COLUMN "officeType",
ADD COLUMN     "officeType" "BusinessPartnerOfficeType" NOT NULL;

-- AlterTable
ALTER TABLE "DealerAuditInstance" DROP COLUMN "officeType",
ADD COLUMN     "officeType" "BusinessPartnerOfficeType" NOT NULL;

-- DropEnum
DROP TYPE "OfficeType";

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_name_officeType_version_key" ON "ChecklistTemplate"("name", "officeType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DealerAuditInstance_dealerUserId_officeType_periodLabel_key" ON "DealerAuditInstance"("dealerUserId", "officeType", "periodLabel");

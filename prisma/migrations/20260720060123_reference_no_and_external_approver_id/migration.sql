/*
  Warnings:

  - A unique constraint covering the columns `[referenceNumber]` on the table `VendorOnboarding` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `referenceNumber` to the `VendorOnboarding` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "isExternalApprover" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TemplateApprover" ADD COLUMN     "isExternalApprover" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VendorOnboarding" ADD COLUMN     "referenceNumber" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "VendorOnboarding_referenceNumber_key" ON "VendorOnboarding"("referenceNumber");

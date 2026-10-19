-- AlterTable
ALTER TABLE "MedicalClaimBill" ADD COLUMN     "approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remarks" TEXT;

-- AlterTable
ALTER TABLE "VendorOnboarding" ADD COLUMN     "vendorReferenceName" TEXT;

-- AlterTable
ALTER TABLE "MedicalClaim" ADD COLUMN     "hospitalisationAlreadySettled" DECIMAL(12,2),
ADD COLUMN     "hospitalisationEligibleAmount" DECIMAL(12,2);

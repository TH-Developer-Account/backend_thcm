-- AlterTable
ALTER TABLE "EventProposal" ADD COLUMN     "deviationAmount" DECIMAL(12,2),
ADD COLUMN     "deviationDocS3Key" TEXT,
ADD COLUMN     "deviationDocUrl" TEXT,
ADD COLUMN     "deviationReason" TEXT;

-- AlterTable
ALTER TABLE "CrfOrder" ADD COLUMN     "trackingNumber" TEXT,
ADD COLUMN     "trackingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "trackingUrl" TEXT;

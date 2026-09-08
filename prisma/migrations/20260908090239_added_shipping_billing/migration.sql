-- AlterTable
ALTER TABLE "BusinessPartnerAddress" ADD COLUMN     "isBillingAddress" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isShippingAddress" BOOLEAN NOT NULL DEFAULT false;

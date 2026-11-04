/*
  Warnings:

  - A unique constraint covering the columns `[crfNumber]` on the table `CRF` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `created_by_id` to the `CRF` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CrfStatus" AS ENUM ('OPEN', 'APPROVED', 'STOCK_SHORTFALL', 'ORDER_FAILED', 'ORDERED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CrfRecipientType" AS ENUM ('SELF', 'EMPLOYEE', 'DEALER_CONTACT', 'OTHER');

-- CreateEnum
CREATE TYPE "CrfAddressSource" AS ENUM ('MANUAL', 'USER_PROFILE', 'BUSINESS_PARTNER_ADDRESS');

-- CreateEnum
CREATE TYPE "CrfItemSource" AS ENUM ('CATALOG', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "CrfItemStatus" AS ENUM ('REQUESTED', 'OUT_OF_STOCK', 'REMOVED', 'ORDERED', 'DEBITED');

-- CreateEnum
CREATE TYPE "CrfOrderStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "CRF" ADD COLUMN     "addressCity" TEXT,
ADD COLUMN     "addressCompany" TEXT,
ADD COLUMN     "addressCountry" TEXT DEFAULT 'India',
ADD COLUMN     "addressDistrict" TEXT,
ADD COLUMN     "addressGstin" VARCHAR(15),
ADD COLUMN     "addressLandmark" TEXT,
ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "addressPincode" VARCHAR(6),
ADD COLUMN     "addressSourceId" TEXT,
ADD COLUMN     "addressSourceType" "CrfAddressSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "addressState" TEXT,
ADD COLUMN     "addressValidatedAt" TIMESTAMP(3),
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "created_by_id" TEXT NOT NULL,
ADD COLUMN     "crfNumber" TEXT,
ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "itemsChangedAt" TIMESTAMP(3),
ADD COLUMN     "recipientContactId" TEXT,
ADD COLUMN     "recipientEmail" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "recipientOrganisation" TEXT,
ADD COLUMN     "recipientPhone" TEXT,
ADD COLUMN     "recipientType" "CrfRecipientType",
ADD COLUMN     "recipientUserId" TEXT,
ADD COLUMN     "requiredByDate" TIMESTAMP(3),
ADD COLUMN     "souvenirTotalAtApproval" DECIMAL(12,2),
ADD COLUMN     "status" "CrfStatus" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "updated_by_id" TEXT;

-- CreateTable
CREATE TABLE "CrfItem" (
    "id" TEXT NOT NULL,
    "crfId" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "source" "CrfItemSource" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "productId" TEXT,
    "quantity" DECIMAL(10,2),
    "rate" DECIMAL(10,2),
    "amount" DECIMAL(12,2),
    "width" TEXT,
    "height" TEXT,
    "unit" TEXT,
    "sku" TEXT,
    "requestedQty" INTEGER,
    "qtyAtApproval" INTEGER,
    "status" "CrfItemStatus" NOT NULL DEFAULT 'REQUESTED',
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "deliveredById" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrfItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrfOrder" (
    "id" TEXT NOT NULL,
    "crfId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "debitNoteAmount" DECIMAL(12,2),
    "status" "CrfOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrfOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrfItem_crfId_status_idx" ON "CrfItem"("crfId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CrfOrder_crfId_key" ON "CrfOrder"("crfId");

-- CreateIndex
CREATE UNIQUE INDEX "CrfOrder_shopifyOrderId_key" ON "CrfOrder"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CRF_crfNumber_key" ON "CRF"("crfNumber");

-- CreateIndex
CREATE INDEX "CRF_status_idx" ON "CRF"("status");

-- AddForeignKey
ALTER TABLE "CRF" ADD CONSTRAINT "CRF_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CRF" ADD CONSTRAINT "CRF_recipientContactId_fkey" FOREIGN KEY ("recipientContactId") REFERENCES "BusinessPartnerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CRF" ADD CONSTRAINT "CRF_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrfItem" ADD CONSTRAINT "CrfItem_crfId_fkey" FOREIGN KEY ("crfId") REFERENCES "CRF"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrfItem" ADD CONSTRAINT "CrfItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMaster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrfOrder" ADD CONSTRAINT "CrfOrder_crfId_fkey" FOREIGN KEY ("crfId") REFERENCES "CRF"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/*
  Warnings:

  - You are about to drop the `crf` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `epf` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `line_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `product_master` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "crf" DROP CONSTRAINT "crf_epcId_fkey";

-- DropForeignKey
ALTER TABLE "epf" DROP CONSTRAINT "epf_epcId_fkey";

-- DropForeignKey
ALTER TABLE "line_items" DROP CONSTRAINT "line_items_crfId_fkey";

-- DropForeignKey
ALTER TABLE "line_items" DROP CONSTRAINT "line_items_epfId_fkey";

-- DropForeignKey
ALTER TABLE "line_items" DROP CONSTRAINT "line_items_productId_fkey";

-- DropTable
DROP TABLE "crf";

-- DropTable
DROP TABLE "epf";

-- DropTable
DROP TABLE "line_items";

-- DropTable
DROP TABLE "product_master";

-- CreateTable
CREATE TABLE "ProductMaster" (
    "id" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "partNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitRate" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EPF" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "total_budget" DECIMAL(12,2),
    "expected_revenue" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EPF_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CRF" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CRF_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL,
    "epfId" TEXT,
    "crfId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaster_partNumber_key" ON "ProductMaster"("partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EPF_epcId_key" ON "EPF"("epcId");

-- CreateIndex
CREATE UNIQUE INDEX "CRF_epcId_key" ON "CRF"("epcId");

-- CreateIndex
CREATE INDEX "LineItem_epfId_idx" ON "LineItem"("epfId");

-- CreateIndex
CREATE INDEX "LineItem_crfId_idx" ON "LineItem"("crfId");

-- AddForeignKey
ALTER TABLE "EPF" ADD CONSTRAINT "EPF_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CRF" ADD CONSTRAINT "CRF_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_epfId_fkey" FOREIGN KEY ("epfId") REFERENCES "EPF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_crfId_fkey" FOREIGN KEY ("crfId") REFERENCES "CRF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LineItem"
ADD CONSTRAINT check_one_parent
CHECK (
  ("epfId" IS NOT NULL AND "crfId" IS NULL)
  OR
  ("epfId" IS NULL AND "crfId" IS NOT NULL)
);

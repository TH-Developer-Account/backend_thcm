-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('EPF', 'CRF');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('EVENT_OVERHEAD', 'PRINTED_MATERIAL', 'SOUVENIR', 'ARTWORK');

-- CreateTable
CREATE TABLE "product_master" (
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

    CONSTRAINT "product_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epf" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "total_budget" DECIMAL(12,2),
    "expected_revenue" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crf" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_items" (
    "id" TEXT NOT NULL,
    "epfId" TEXT,
    "crfId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_master_partNumber_key" ON "product_master"("partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "epf_epcId_key" ON "epf"("epcId");

-- CreateIndex
CREATE UNIQUE INDEX "crf_epcId_key" ON "crf"("epcId");

-- CreateIndex
CREATE INDEX "line_items_epfId_idx" ON "line_items"("epfId");

-- CreateIndex
CREATE INDEX "line_items_crfId_idx" ON "line_items"("crfId");

-- AddForeignKey
ALTER TABLE "epf" ADD CONSTRAINT "epf_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crf" ADD CONSTRAINT "crf_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_epfId_fkey" FOREIGN KEY ("epfId") REFERENCES "epf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_crfId_fkey" FOREIGN KEY ("crfId") REFERENCES "crf"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


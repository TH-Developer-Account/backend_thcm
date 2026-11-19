-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "custCode" TEXT,
ADD COLUMN     "goodsReceiptDate" TIMESTAMP(3),
ADD COLUMN     "goodsReceiptValue" INTEGER,
ADD COLUMN     "invoiceDate" TIMESTAMP(3),
ADD COLUMN     "invoiceNo" TEXT,
ADD COLUMN     "invoiceValue" INTEGER,
ADD COLUMN     "masterWarranty" INTEGER,
ADD COLUMN     "mcDescription" TEXT,
ADD COLUMN     "mcStatus" TEXT,
ADD COLUMN     "modelName" TEXT,
ADD COLUMN     "plant" TEXT,
ADD COLUMN     "purchaseOrderDate" TIMESTAMP(3),
ADD COLUMN     "purchaseOrderNo" TEXT,
ADD COLUMN     "serviceDealerCode" TEXT,
ADD COLUMN     "siteLocation" TEXT,
ADD COLUMN     "warrantyEnd" TIMESTAMP(3),
ADD COLUMN     "warrantyStart" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Machine_custCode_idx" ON "Machine"("custCode");

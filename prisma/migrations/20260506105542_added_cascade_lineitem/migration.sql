-- DropForeignKey
ALTER TABLE "LineItem" DROP CONSTRAINT "LineItem_crfId_fkey";

-- DropForeignKey
ALTER TABLE "LineItem" DROP CONSTRAINT "LineItem_epfId_fkey";

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_epfId_fkey" FOREIGN KEY ("epfId") REFERENCES "EPF"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_crfId_fkey" FOREIGN KEY ("crfId") REFERENCES "CRF"("id") ON DELETE CASCADE ON UPDATE CASCADE;

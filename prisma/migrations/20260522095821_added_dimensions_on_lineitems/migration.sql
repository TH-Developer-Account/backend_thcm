/*
  Warnings:

  - You are about to drop the column `dimensions` on the `ProductMaster` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "height" TEXT,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "width" TEXT;

-- AlterTable
ALTER TABLE "ProductMaster" DROP COLUMN "dimensions";

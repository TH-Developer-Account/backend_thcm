-- AlterTable
ALTER TABLE "ProductMaster" ADD COLUMN     "dimensions" TEXT,
ALTER COLUMN "unitRate" DROP NOT NULL;

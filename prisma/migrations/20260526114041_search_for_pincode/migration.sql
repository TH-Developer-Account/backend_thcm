/*
  Warnings:

  - Made the column `latitude` on table `Pincode` required. This step will fail if there are existing NULL values in that column.
  - Made the column `longitude` on table `Pincode` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Pincode_searchVector_idx";

-- AlterTable
ALTER TABLE "Pincode" ALTER COLUMN "latitude" SET NOT NULL,
ALTER COLUMN "longitude" SET NOT NULL;

/*
  Warnings:

  - Made the column `code` on table `Vertical` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Vertical_code_key";

-- AlterTable
ALTER TABLE "Vertical" ALTER COLUMN "code" SET NOT NULL;

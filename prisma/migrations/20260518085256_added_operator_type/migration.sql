/*
  Warnings:

  - Added the required column `operatorType` to the `Operator` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "operatorType" TEXT NOT NULL;

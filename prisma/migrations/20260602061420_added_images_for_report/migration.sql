/*
  Warnings:

  - You are about to drop the column `actualSpend` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `fileUrl` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `s3Key` on the `EventReport` table. All the data in the column will be lost.
  - Added the required column `approvedEventCost` to the `EventReport` table without a default value. This is not possible if the table is not empty.
  - Added the required column `outcomeStatus` to the `EventReport` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalLeadsGenerated` to the `EventReport` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('SUCCESSFUL', 'PARTIALLY_SUCCESSFUL', 'UNSUCCESSFUL');

-- AlterTable
ALTER TABLE "EventReport" DROP COLUMN "actualSpend",
DROP COLUMN "description",
DROP COLUMN "fileUrl",
DROP COLUMN "notes",
DROP COLUMN "s3Key",
ADD COLUMN     "approvedEventCost" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "expectedConversion" TEXT,
ADD COLUMN     "outcomeStatus" "OutcomeStatus" NOT NULL,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "totalLeadsGenerated" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "EventReportImage" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "s3Key" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,

    CONSTRAINT "EventReportImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventReportImage_reportId_idx" ON "EventReportImage"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "EventReportImage_reportId_position_key" ON "EventReportImage"("reportId", "position");

-- AddForeignKey
ALTER TABLE "EventReportImage" ADD CONSTRAINT "EventReportImage_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "EventReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

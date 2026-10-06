/*
  Warnings:

  - You are about to drop the column `approvedEventCost` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `expectedConversion` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `outcomeStatus` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `remarks` on the `EventReport` table. All the data in the column will be lost.
  - You are about to drop the column `totalLeadsGenerated` on the `EventReport` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[reportTemplateKey]` on the table `EventName` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ParticipantType" AS ENUM ('CUSTOMER', 'CUSTOMER_KEY_ACCOUNT', 'CUSTOMER_STAFF', 'VENDOR_PARTNER', 'HITACHI_REPRESENTATIVE', 'TATA_HITACHI_EXECUTIVE', 'DEALERSHIP_EXECUTIVE', 'FINANCIER_EXECUTIVE', 'MACHINE_OPERATOR', 'MACHINE_MECHANIC', 'OTHER');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('COLD_ENQUIRY', 'WARM_ENQUIRY', 'HOT_ENQUIRY', 'EVENT_ATTENDEE', 'FELICITATION', 'KEY_HANDOVER', 'BOOKING');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('DIESEL', 'ELECTRIC');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportStatus" ADD VALUE 'GENERATING';
ALTER TYPE "ReportStatus" ADD VALUE 'GENERATION_FAILED';

-- AlterTable
ALTER TABLE "EventName" ADD COLUMN     "reportTemplateKey" TEXT;

-- AlterTable
ALTER TABLE "EventReport" DROP COLUMN "approvedEventCost",
DROP COLUMN "expectedConversion",
DROP COLUMN "outcomeStatus",
DROP COLUMN "remarks",
DROP COLUMN "totalLeadsGenerated",
ADD COLUMN     "computedOutcomes" JSONB,
ADD COLUMN     "eventHighlights" TEXT,
ADD COLUMN     "generationError" TEXT,
ADD COLUMN     "pdfS3Key" TEXT,
ALTER COLUMN "status" SET DEFAULT 'GENERATING';

-- AlterTable
ALTER TABLE "EventReportImage" ADD COLUMN     "caption" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "companyName" VARCHAR(150),
ADD COLUMN     "dealership" VARCHAR(150),
ADD COLUMN     "district" TEXT,
ADD COLUMN     "eventDate" TIMESTAMP(3),
ADD COLUMN     "location" TEXT,
ADD COLUMN     "machineModel" VARCHAR(150),
ADD COLUMN     "machineSerial" VARCHAR(100),
ADD COLUMN     "participantStatus" "ParticipantStatus",
ADD COLUMN     "participantType" "ParticipantType",
ADD COLUMN     "state" TEXT,
ADD COLUMN     "valueOfPartsBilled" DECIMAL(12,2),
ADD COLUMN     "valueOfPartsOffers" DECIMAL(12,2),
ADD COLUMN     "valueOfServiceOffers" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "MachineStudy" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "isCompetitorMachine" BOOLEAN NOT NULL DEFAULT false,
    "machineModel" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "application" TEXT NOT NULL,
    "fuelType" "FuelType" NOT NULL,
    "startHmr" DECIMAL(10,2) NOT NULL,
    "endHmr" DECIMAL(10,2) NOT NULL,
    "bucketVolumeCuM" DECIMAL(6,2) NOT NULL,
    "acStatus" TEXT NOT NULL,
    "operationMode" TEXT NOT NULL,
    "dieselTopUpLtr" DECIMAL(8,2),
    "startKwhReading" DECIMAL(10,2),
    "endKwhReading" DECIMAL(10,2),
    "operatorName" TEXT,
    "operatorExperience" TEXT,
    "priorMachinesOperated" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineStudy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineStudyCycle" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "sequenceNo" INTEGER NOT NULL,
    "truckNumber" TEXT,
    "startSeconds" INTEGER NOT NULL,
    "finishSeconds" INTEGER NOT NULL,
    "timeTakenSeconds" INTEGER NOT NULL,
    "bucketPasses" INTEGER,
    "swingAngleDegrees" TEXT,
    "unladenWeightKg" DECIMAL(8,2),
    "ladenWeightKg" DECIMAL(8,2),
    "payloadKg" DECIMAL(8,2),
    "remarks" TEXT,

    CONSTRAINT "MachineStudyCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineStudy_epcId_idx" ON "MachineStudy"("epcId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineStudy_epcId_isCompetitorMachine_key" ON "MachineStudy"("epcId", "isCompetitorMachine");

-- CreateIndex
CREATE INDEX "MachineStudyCycle_studyId_idx" ON "MachineStudyCycle"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "EventName_reportTemplateKey_key" ON "EventName"("reportTemplateKey");

-- CreateIndex
CREATE INDEX "Lead_participantStatus_idx" ON "Lead"("participantStatus");

-- AddForeignKey
ALTER TABLE "MachineStudy" ADD CONSTRAINT "MachineStudy_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineStudyCycle" ADD CONSTRAINT "MachineStudyCycle_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "MachineStudy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

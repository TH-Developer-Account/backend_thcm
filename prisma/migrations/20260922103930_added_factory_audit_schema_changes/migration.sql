/*
  Warnings:

  - You are about to drop the column `roundId` on the `AuditAssignment` table. All the data in the column will be lost.
  - You are about to drop the column `roundId` on the `AuditCheckpointResult` table. All the data in the column will be lost.
  - You are about to drop the column `evaluationState` on the `FactoryAuditInstance` table. All the data in the column will be lost.
  - You are about to drop the column `currentClassificationBandId` on the `Supplier` table. All the data in the column will be lost.
  - You are about to drop the column `bandId` on the `VendorClassificationHistory` table. All the data in the column will be lost.
  - You are about to drop the column `roundId` on the `VendorClassificationHistory` table. All the data in the column will be lost.
  - You are about to drop the `AuditAssignmentCheckpoint` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuditResponse` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuditRound` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuditRoundCheckpointScope` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CheckpointRubricLevel` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `FactoryClassificationBand` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[auditInstanceId,auditorId]` on the table `AuditAssignment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[auditInstanceId,checkpointId]` on the table `AuditCheckpointResult` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `auditInstanceId` to the `AuditAssignment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `auditInstanceId` to the `AuditCheckpointResult` table without a default value. This is not possible if the table is not empty.
  - Added the required column `criteria` to the `FactoryAuditCheckpoint` table without a default value. This is not possible if the table is not empty.
  - Added the required column `workspaceId` to the `FactoryAuditInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `processCategory` to the `Supplier` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bandLabel` to the `VendorClassificationHistory` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "FactoryAuditInstanceType" AS ENUM ('INITIAL', 'REOPEN', 'SUB_AUDIT');

-- DropForeignKey
ALTER TABLE "AuditAssignment" DROP CONSTRAINT "AuditAssignment_roundId_fkey";

-- DropForeignKey
ALTER TABLE "AuditAssignmentCheckpoint" DROP CONSTRAINT "AuditAssignmentCheckpoint_assignmentId_fkey";

-- DropForeignKey
ALTER TABLE "AuditAssignmentCheckpoint" DROP CONSTRAINT "AuditAssignmentCheckpoint_checkpointId_fkey";

-- DropForeignKey
ALTER TABLE "AuditCheckpointResult" DROP CONSTRAINT "AuditCheckpointResult_roundId_fkey";

-- DropForeignKey
ALTER TABLE "AuditResponse" DROP CONSTRAINT "AuditResponse_assignmentId_fkey";

-- DropForeignKey
ALTER TABLE "AuditResponse" DROP CONSTRAINT "AuditResponse_checkpointId_fkey";

-- DropForeignKey
ALTER TABLE "AuditRound" DROP CONSTRAINT "AuditRound_auditInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "AuditRound" DROP CONSTRAINT "AuditRound_triggeredByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AuditRoundCheckpointScope" DROP CONSTRAINT "AuditRoundCheckpointScope_checkpointId_fkey";

-- DropForeignKey
ALTER TABLE "AuditRoundCheckpointScope" DROP CONSTRAINT "AuditRoundCheckpointScope_roundId_fkey";

-- DropForeignKey
ALTER TABLE "CheckpointRubricLevel" DROP CONSTRAINT "CheckpointRubricLevel_checkpointId_fkey";

-- DropForeignKey
ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_currentClassificationBandId_fkey";

-- DropForeignKey
ALTER TABLE "VendorClassificationHistory" DROP CONSTRAINT "VendorClassificationHistory_bandId_fkey";

-- DropForeignKey
ALTER TABLE "VendorClassificationHistory" DROP CONSTRAINT "VendorClassificationHistory_roundId_fkey";

-- DropIndex
DROP INDEX "AuditAssignment_roundId_auditorId_key";

-- DropIndex
DROP INDEX "AuditCheckpointResult_roundId_checkpointId_key";

-- AlterTable
ALTER TABLE "AuditAssignment" DROP COLUMN "roundId",
ADD COLUMN     "auditInstanceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AuditCheckpointResult" DROP COLUMN "roundId",
ADD COLUMN     "auditInstanceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "FactoryAuditCheckpoint" ADD COLUMN     "criteria" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "FactoryAuditInstance" DROP COLUMN "evaluationState",
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "scopedCheckpointIds" TEXT[],
ADD COLUMN     "type" "FactoryAuditInstanceType" NOT NULL DEFAULT 'INITIAL',
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Supplier" DROP COLUMN "currentClassificationBandId",
ADD COLUMN     "currentClassificationBandLabel" TEXT,
ADD COLUMN     "currentClassificationQualifiesFor" "PartCategory"[],
ADD COLUMN     "processCategory" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "VendorClassificationHistory" DROP COLUMN "bandId",
DROP COLUMN "roundId",
ADD COLUMN     "bandLabel" TEXT NOT NULL,
ADD COLUMN     "qualifiesFor" "PartCategory"[];

-- DropTable
DROP TABLE "AuditAssignmentCheckpoint";

-- DropTable
DROP TABLE "AuditResponse";

-- DropTable
DROP TABLE "AuditRound";

-- DropTable
DROP TABLE "AuditRoundCheckpointScope";

-- DropTable
DROP TABLE "CheckpointRubricLevel";

-- DropTable
DROP TABLE "FactoryClassificationBand";

-- CreateTable
CREATE TABLE "FactoryAuditResponse" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "score" DOUBLE PRECISION,
    "isNotApplicable" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,

    CONSTRAINT "FactoryAuditResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactoryAuditResponse_assignmentId_checkpointId_iteration_key" ON "FactoryAuditResponse"("assignmentId", "checkpointId", "iteration");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAssignment_auditInstanceId_auditorId_key" ON "AuditAssignment"("auditInstanceId", "auditorId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditCheckpointResult_auditInstanceId_checkpointId_key" ON "AuditCheckpointResult"("auditInstanceId", "checkpointId");

-- CreateIndex
CREATE INDEX "FactoryAuditInstance_parentId_idx" ON "FactoryAuditInstance"("parentId");

-- AddForeignKey
ALTER TABLE "FactoryAuditInstance" ADD CONSTRAINT "FactoryAuditInstance_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FactoryAuditInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignment" ADD CONSTRAINT "AuditAssignment_auditInstanceId_fkey" FOREIGN KEY ("auditInstanceId") REFERENCES "FactoryAuditInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditResponse" ADD CONSTRAINT "FactoryAuditResponse_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AuditAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditResponse" ADD CONSTRAINT "FactoryAuditResponse_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCheckpointResult" ADD CONSTRAINT "AuditCheckpointResult_auditInstanceId_fkey" FOREIGN KEY ("auditInstanceId") REFERENCES "FactoryAuditInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

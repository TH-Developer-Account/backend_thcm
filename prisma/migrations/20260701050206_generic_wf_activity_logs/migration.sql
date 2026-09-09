/*
  Warnings:

  - You are about to drop the column `eventProposalId` on the `WorkflowInstance` table. All the data in the column will be lost.
  - Added the required column `subjectId` to the `ActivityLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subjectType` to the `ActivityLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `appId` to the `WorkflowInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subjectId` to the `WorkflowInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subjectType` to the `WorkflowInstance` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WorkflowSubjectType" AS ENUM ('EVENT_PROPOSAL', 'AUDIT_INSTANCE');

-- DropForeignKey
ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_epcId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowInstance" DROP CONSTRAINT "WorkflowInstance_eventProposalId_fkey";

-- DropIndex
DROP INDEX "WorkflowInstance_eventProposalId_isActive_idx";

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "subjectId" TEXT NOT NULL,
ADD COLUMN     "subjectType" "WorkflowSubjectType" NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowInstance" DROP COLUMN "eventProposalId",
ADD COLUMN     "appId" TEXT NOT NULL,
ADD COLUMN     "subjectId" TEXT NOT NULL,
ADD COLUMN     "subjectType" "WorkflowSubjectType" NOT NULL;

-- CreateIndex
CREATE INDEX "WorkflowInstance_subjectType_subjectId_isActive_idx" ON "WorkflowInstance"("subjectType", "subjectId", "isActive");

-- CreateIndex
CREATE INDEX "WorkflowInstance_appId_isActive_idx" ON "WorkflowInstance"("appId", "isActive");

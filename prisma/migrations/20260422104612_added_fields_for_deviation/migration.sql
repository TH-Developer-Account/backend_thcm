/*
  Warnings:

  - A unique constraint covering the columns `[workflowId,stageOrder,iteration]` on the table `StageInstance` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `action` on the `ApprovalAudit` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "WorkflowType" AS ENUM ('STANDARD', 'DEVIATION');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('APPROVED', 'REJECTED', 'CLARIFY', 'DEVIATION');

-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'CLARIFY';

-- AlterEnum
ALTER TYPE "WorkflowStatus" ADD VALUE 'SUPERSEDED';

-- DropIndex
DROP INDEX "StageInstance_workflowId_stageOrder_key";

-- DropIndex
DROP INDEX "WorkflowInstance_eventProposalId_key";

-- AlterTable
ALTER TABLE "ApprovalAudit" DROP COLUMN "action",
ADD COLUMN     "action" "AuditAction" NOT NULL;

-- AlterTable
ALTER TABLE "StageInstance" ADD COLUMN     "isCurrentIteration" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "iteration" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "WorkflowInstance" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "iteration" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "workflowType" "WorkflowType" NOT NULL DEFAULT 'STANDARD';

-- CreateIndex
CREATE INDEX "StageInstance_workflowId_isCurrentIteration_idx" ON "StageInstance"("workflowId", "isCurrentIteration");

-- CreateIndex
CREATE UNIQUE INDEX "StageInstance_workflowId_stageOrder_iteration_key" ON "StageInstance"("workflowId", "stageOrder", "iteration");

-- CreateIndex
CREATE INDEX "WorkflowInstance_eventProposalId_isActive_idx" ON "WorkflowInstance"("eventProposalId", "isActive");

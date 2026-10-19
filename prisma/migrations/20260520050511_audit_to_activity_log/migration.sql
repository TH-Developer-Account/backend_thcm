/*
  Warnings:

  - You are about to drop the `ApprovalAudit` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('EPC_CREATED', 'EPC_UPDATED', 'EPC_DELETED', 'EPF_SUBMITTED', 'CRF_SUBMITTED', 'EPC_RESUBMITTED', 'APPROVED', 'REJECTED', 'CLARIFY', 'DEVIATION_RAISED');

-- DropForeignKey
ALTER TABLE "ApprovalAudit" DROP CONSTRAINT "ApprovalAudit_approverId_fkey";

-- DropForeignKey
ALTER TABLE "ApprovalAudit" DROP CONSTRAINT "ApprovalAudit_stageId_fkey";

-- DropForeignKey
ALTER TABLE "ApprovalAudit" DROP CONSTRAINT "ApprovalAudit_workflowId_fkey";

-- DropTable
DROP TABLE "ApprovalAudit";

-- DropEnum
DROP TYPE "AuditAction";

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "ActivityAction" NOT NULL,
    "workflowId" TEXT,
    "stageId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityLog_epcId_idx" ON "ActivityLog"("epcId");

-- CreateIndex
CREATE INDEX "ActivityLog_actorId_idx" ON "ActivityLog"("actorId");

-- CreateIndex
CREATE INDEX "ActivityLog_workflowId_idx" ON "ActivityLog"("workflowId");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "StageInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

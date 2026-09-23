-- AlterTable
ALTER TABLE "ApprovalAudit" ALTER COLUMN "stageId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ApprovalAudit_workflowId_idx" ON "ApprovalAudit"("workflowId");

-- CreateIndex
CREATE INDEX "ApprovalAudit_approverId_idx" ON "ApprovalAudit"("approverId");

-- AddForeignKey
ALTER TABLE "ApprovalAudit" ADD CONSTRAINT "ApprovalAudit_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAudit" ADD CONSTRAINT "ApprovalAudit_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "StageInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAudit" ADD CONSTRAINT "ApprovalAudit_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

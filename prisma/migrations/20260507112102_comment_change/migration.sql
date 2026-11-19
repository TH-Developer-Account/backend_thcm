-- DropIndex
DROP INDEX "Comment_approvalId_idx";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "workflowId" TEXT,
ALTER COLUMN "approvalId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

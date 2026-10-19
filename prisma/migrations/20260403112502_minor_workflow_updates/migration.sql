-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "StageInstance" ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "escalatedTo" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ApprovalAudit" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "action" "ApprovalStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalAudit_pkey" PRIMARY KEY ("id")
);

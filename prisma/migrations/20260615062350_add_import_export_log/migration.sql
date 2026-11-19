-- CreateEnum
CREATE TYPE "ImportExportType" AS ENUM ('LEAD_IMPORT', 'LEAD_EXPORT', 'EPC_EXPORT');

-- CreateEnum
CREATE TYPE "ImportExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ImportExportLog" (
    "id" TEXT NOT NULL,
    "type" "ImportExportType" NOT NULL,
    "status" "ImportExportStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredById" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "epcId" TEXT,
    "jobId" TEXT NOT NULL,
    "totalRecords" INTEGER,
    "successRecords" INTEGER,
    "failedRecords" INTEGER,
    "fileS3Key" TEXT,
    "errorFileS3Key" TEXT,
    "failureReason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportExportLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportExportLog_workspaceId_type_idx" ON "ImportExportLog"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "ImportExportLog_triggeredById_idx" ON "ImportExportLog"("triggeredById");

-- CreateIndex
CREATE INDEX "ImportExportLog_epcId_idx" ON "ImportExportLog"("epcId");

-- CreateIndex
CREATE INDEX "ImportExportLog_jobId_idx" ON "ImportExportLog"("jobId");

-- AddForeignKey
ALTER TABLE "ImportExportLog" ADD CONSTRAINT "ImportExportLog_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportExportLog" ADD CONSTRAINT "ImportExportLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportExportLog" ADD CONSTRAINT "ImportExportLog_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

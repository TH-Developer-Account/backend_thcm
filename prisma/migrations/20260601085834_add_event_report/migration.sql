/*
  Warnings:

  - The values [EPC_CANCELLED] on the enum `ActivityAction` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('SUBMITTED', 'VALIDATED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "ActivityAction_new" AS ENUM ('EPC_CREATED', 'EPC_UPDATED', 'EPF_CREATED', 'EPF_UPDATED', 'CRF_CREATED', 'CRF_UPDATED', 'EPC_RESUBMITTED', 'EPC_CONDUCTED', 'REPORT_SUBMITTED', 'REPORT_RESUBMITTED', 'REPORT_VALIDATED', 'REPORT_REJECTED', 'EPC_CLOSED', 'APPROVED', 'REJECTED', 'CLARIFY', 'DEVIATION_RAISED');
ALTER TABLE "ActivityLog" ALTER COLUMN "action" TYPE "ActivityAction_new" USING ("action"::text::"ActivityAction_new");
ALTER TYPE "ActivityAction" RENAME TO "ActivityAction_old";
ALTER TYPE "ActivityAction_new" RENAME TO "ActivityAction";
DROP TYPE "public"."ActivityAction_old";
COMMIT;

-- CreateTable
CREATE TABLE "EventReport" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "actualSpend" DECIMAL(12,2) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resubmittedAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3),
    "validatorId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventReport_epcId_key" ON "EventReport"("epcId");

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_validatorId_fkey" FOREIGN KEY ("validatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

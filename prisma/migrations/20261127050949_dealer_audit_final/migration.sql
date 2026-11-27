/*
  Warnings:

  - You are about to drop the column `category` on the `ChecklistItem` table. All the data in the column will be lost.
  - You are about to drop the column `scoringGuidance` on the `ChecklistItem` table. All the data in the column will be lost.
  - You are about to drop the column `sectionName` on the `ChecklistItem` table. All the data in the column will be lost.
  - You are about to drop the `ChecklistScoreLevel` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[businessPartnerId,officeType,periodLabel,sequence]` on the table `DealerAuditInstance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `AuditItemResponse` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ChecklistScoreLevel" DROP CONSTRAINT "ChecklistScoreLevel_itemId_fkey";

-- DropIndex
DROP INDEX "DealerAuditInstance_businessPartnerId_officeType_periodLabe_key";

-- AlterTable
ALTER TABLE "AuditItemResponse" ADD COLUMN     "dealerRespondedAt" TIMESTAMP(3),
ADD COLUMN     "isNotApplicable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "ChecklistItem" DROP COLUMN "category",
DROP COLUMN "scoringGuidance",
DROP COLUMN "sectionName",
ADD COLUMN     "allowNotApplicable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scoreLevels" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "requiresEvidence" SET DEFAULT true,
ALTER COLUMN "minEvidence" SET DEFAULT 1,
ALTER COLUMN "maxEvidence" SET DEFAULT 4;

-- AlterTable
ALTER TABLE "ChecklistTemplate" ADD COLUMN     "gradeBands" JSONB,
ADD COLUMN     "passPercent" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DealerAuditCycle" ADD COLUMN     "updatedById" TEXT;

-- AlterTable
ALTER TABLE "DealerAuditInstance" ADD COLUMN     "auditType" TEXT NOT NULL DEFAULT 'REGULAR',
ADD COLUMN     "clarificationDueAt" TIMESTAMP(3),
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "grade" TEXT,
ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "reAuditReason" TEXT,
ADD COLUMN     "reAuditRequestedAt" TIMESTAMP(3),
ADD COLUMN     "reportSentAt" TIMESTAMP(3),
ADD COLUMN     "scopeItemIds" JSONB,
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "accuracyMeters" DOUBLE PRECISION,
ADD COLUMN     "auditItemResponseId" TEXT,
ALTER COLUMN "subjectType" DROP NOT NULL,
ALTER COLUMN "subjectId" DROP NOT NULL;

-- DropTable
DROP TABLE "ChecklistScoreLevel";

-- CreateIndex
CREATE INDEX "DealerAuditInstance_status_clarificationDueAt_idx" ON "DealerAuditInstance"("status", "clarificationDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "DealerAuditInstance_businessPartnerId_officeType_periodLabe_key" ON "DealerAuditInstance"("businessPartnerId", "officeType", "periodLabel", "sequence");

-- CreateIndex
CREATE INDEX "Evidence_auditItemResponseId_idx" ON "Evidence"("auditItemResponseId");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_auditItemResponseId_fkey" FOREIGN KEY ("auditItemResponseId") REFERENCES "AuditItemResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DealerAuditInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

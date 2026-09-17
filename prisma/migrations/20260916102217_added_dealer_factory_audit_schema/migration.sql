-- CreateEnum
CREATE TYPE "TemplateLifecycleStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "EvidenceSubjectType" AS ENUM ('DEALER_ITEM_RESPONSE', 'FACTORY_AUDIT_RESPONSE');

-- CreateEnum
CREATE TYPE "OfficeType" AS ENUM ('ALL', 'HO', 'RO', 'BO', 'FOV');

-- CreateEnum
CREATE TYPE "ChecklistItemCategory" AS ENUM ('INFRA', 'PROCESS');

-- CreateEnum
CREATE TYPE "DealerReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CLARIFICATION_REQUESTED');

-- CreateEnum
CREATE TYPE "AuditorRole" AS ENUM ('QUALITY', 'SCM', 'PE');

-- CreateEnum
CREATE TYPE "PartCategory" AS ENUM ('S', 'C', 'A', 'GENERAL');

-- CreateEnum
CREATE TYPE "EvaluationState" AS ENUM ('NEW', 'REAUDIT');

-- CreateEnum
CREATE TYPE "RoundTriggerReason" AS ENUM ('INITIAL', 'FAILED_REAUDIT', 'REMARKS_SUBAUDIT');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'SUBMITTED', 'REASSIGNED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowSubjectType" ADD VALUE 'DEALER_AUDIT_INSTANCE';
ALTER TYPE "WorkflowSubjectType" ADD VALUE 'FACTORY_AUDIT_INSTANCE';

-- AlterTable
ALTER TABLE "WorkFlowTemplateUser" ADD COLUMN     "isFallbackApprover" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "subjectType" "EvidenceSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geoLat" DOUBLE PRECISION,
    "geoLng" DOUBLE PRECISION,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentClassificationBandId" TEXT,
    "currentClassificationDecidedAt" TIMESTAMP(3),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "officeType" "OfficeType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "TemplateLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sectionName" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "checkPoint" TEXT NOT NULL,
    "category" "ChecklistItemCategory",
    "requiresScore" BOOLEAN NOT NULL DEFAULT true,
    "requiresEvidence" BOOLEAN NOT NULL DEFAULT false,
    "maxScore" DOUBLE PRECISION,
    "scoringGuidance" TEXT,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerAuditInstance" (
    "id" TEXT NOT NULL,
    "dealerUserId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "officeType" "OfficeType" NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "checklistTemplateId" TEXT NOT NULL,
    "finalScore" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerAuditInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditItemResponse" (
    "id" TEXT NOT NULL,
    "auditInstanceId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "dealerScore" DOUBLE PRECISION,
    "dealerRemark" TEXT,
    "reviewerScore" DOUBLE PRECISION,
    "reviewerRemark" TEXT,
    "reviewStatus" "DealerReviewStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditItemResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryAuditTemplate" (
    "id" TEXT NOT NULL,
    "processCategory" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "TemplateLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactoryAuditTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryAuditSection" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "passThreshold" DOUBLE PRECISION NOT NULL,
    "elevatedPassThresholdForCriticalParts" DOUBLE PRECISION,

    CONSTRAINT "FactoryAuditSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryAuditCheckpoint" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "checkPoint" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "requiresEvidence" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FactoryAuditCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckpointRubricLevel" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "CheckpointRubricLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryClassificationBand" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minPercent" DOUBLE PRECISION NOT NULL,
    "maxPercent" DOUBLE PRECISION NOT NULL,
    "qualifiesFor" "PartCategory"[],

    CONSTRAINT "FactoryClassificationBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryAuditInstance" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "evaluationState" "EvaluationState" NOT NULL DEFAULT 'NEW',
    "targetPartCategories" "PartCategory"[],
    "reopenUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactoryAuditInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRound" (
    "id" TEXT NOT NULL,
    "auditInstanceId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "triggerReason" "RoundTriggerReason" NOT NULL,
    "triggeredByUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AuditRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRoundCheckpointScope" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,

    CONSTRAINT "AuditRoundCheckpointScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditAssignment" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "auditorId" TEXT NOT NULL,
    "role" "AuditorRole" NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "reassignedFromId" TEXT,

    CONSTRAINT "AuditAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditAssignmentCheckpoint" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,

    CONSTRAINT "AuditAssignmentCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditResponse" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "isNotApplicable" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,

    CONSTRAINT "AuditResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditCheckpointResult" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerFlaggedForImprovement" BOOLEAN NOT NULL DEFAULT false,
    "reviewerRemark" TEXT,
    "reviewerId" TEXT,
    "reviewerRemarkedAt" TIMESTAMP(3),

    CONSTRAINT "AuditCheckpointResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorClassificationHistory" (
    "id" TEXT NOT NULL,
    "auditInstanceId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "bandId" TEXT NOT NULL,
    "overallScorePercent" DOUBLE PRECISION NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorClassificationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Evidence_subjectType_subjectId_idx" ON "Evidence"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_name_officeType_version_key" ON "ChecklistTemplate"("name", "officeType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistItem_templateId_order_key" ON "ChecklistItem"("templateId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "DealerAuditInstance_dealerUserId_officeType_periodLabel_key" ON "DealerAuditInstance"("dealerUserId", "officeType", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "AuditItemResponse_auditInstanceId_itemId_iteration_key" ON "AuditItemResponse"("auditInstanceId", "itemId", "iteration");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryAuditTemplate_processCategory_version_key" ON "FactoryAuditTemplate"("processCategory", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryAuditSection_templateId_order_key" ON "FactoryAuditSection"("templateId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryAuditCheckpoint_sectionId_order_key" ON "FactoryAuditCheckpoint"("sectionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "CheckpointRubricLevel_checkpointId_level_key" ON "CheckpointRubricLevel"("checkpointId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryClassificationBand_label_key" ON "FactoryClassificationBand"("label");

-- CreateIndex
CREATE UNIQUE INDEX "AuditRound_auditInstanceId_roundNumber_key" ON "AuditRound"("auditInstanceId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AuditRoundCheckpointScope_roundId_checkpointId_key" ON "AuditRoundCheckpointScope"("roundId", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAssignment_roundId_auditorId_key" ON "AuditAssignment"("roundId", "auditorId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAssignmentCheckpoint_assignmentId_checkpointId_key" ON "AuditAssignmentCheckpoint"("assignmentId", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditResponse_assignmentId_checkpointId_key" ON "AuditResponse"("assignmentId", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditCheckpointResult_roundId_checkpointId_key" ON "AuditCheckpointResult"("roundId", "checkpointId");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_currentClassificationBandId_fkey" FOREIGN KEY ("currentClassificationBandId") REFERENCES "FactoryClassificationBand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_dealerUserId_fkey" FOREIGN KEY ("dealerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_checklistTemplateId_fkey" FOREIGN KEY ("checklistTemplateId") REFERENCES "ChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditItemResponse" ADD CONSTRAINT "AuditItemResponse_auditInstanceId_fkey" FOREIGN KEY ("auditInstanceId") REFERENCES "DealerAuditInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditItemResponse" ADD CONSTRAINT "AuditItemResponse_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditSection" ADD CONSTRAINT "FactoryAuditSection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FactoryAuditTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditCheckpoint" ADD CONSTRAINT "FactoryAuditCheckpoint_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "FactoryAuditSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointRubricLevel" ADD CONSTRAINT "CheckpointRubricLevel_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditInstance" ADD CONSTRAINT "FactoryAuditInstance_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditInstance" ADD CONSTRAINT "FactoryAuditInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FactoryAuditTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryAuditInstance" ADD CONSTRAINT "FactoryAuditInstance_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRound" ADD CONSTRAINT "AuditRound_auditInstanceId_fkey" FOREIGN KEY ("auditInstanceId") REFERENCES "FactoryAuditInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRound" ADD CONSTRAINT "AuditRound_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRoundCheckpointScope" ADD CONSTRAINT "AuditRoundCheckpointScope_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "AuditRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRoundCheckpointScope" ADD CONSTRAINT "AuditRoundCheckpointScope_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignment" ADD CONSTRAINT "AuditAssignment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "AuditRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignment" ADD CONSTRAINT "AuditAssignment_auditorId_fkey" FOREIGN KEY ("auditorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignment" ADD CONSTRAINT "AuditAssignment_reassignedFromId_fkey" FOREIGN KEY ("reassignedFromId") REFERENCES "AuditAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignmentCheckpoint" ADD CONSTRAINT "AuditAssignmentCheckpoint_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AuditAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditAssignmentCheckpoint" ADD CONSTRAINT "AuditAssignmentCheckpoint_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditResponse" ADD CONSTRAINT "AuditResponse_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AuditAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditResponse" ADD CONSTRAINT "AuditResponse_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCheckpointResult" ADD CONSTRAINT "AuditCheckpointResult_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "AuditRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCheckpointResult" ADD CONSTRAINT "AuditCheckpointResult_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "FactoryAuditCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCheckpointResult" ADD CONSTRAINT "AuditCheckpointResult_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClassificationHistory" ADD CONSTRAINT "VendorClassificationHistory_auditInstanceId_fkey" FOREIGN KEY ("auditInstanceId") REFERENCES "FactoryAuditInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClassificationHistory" ADD CONSTRAINT "VendorClassificationHistory_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "AuditRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClassificationHistory" ADD CONSTRAINT "VendorClassificationHistory_bandId_fkey" FOREIGN KEY ("bandId") REFERENCES "FactoryClassificationBand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClassificationHistory" ADD CONSTRAINT "VendorClassificationHistory_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

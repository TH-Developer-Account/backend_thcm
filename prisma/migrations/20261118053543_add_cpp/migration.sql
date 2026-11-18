-- AlterEnum
ALTER TYPE "WorkflowSubjectType" ADD VALUE 'CPP_REQUEST';

-- CreateTable
CREATE TABLE "CppRequest" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiatedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "category" TEXT,
    "plant" TEXT,
    "condition" TEXT,
    "isSpare" BOOLEAN NOT NULL DEFAULT false,
    "reasonCode" TEXT,
    "supplierName" TEXT,
    "supplierCode" TEXT,
    "maxPartValue" DECIMAL(18,2),
    "maxVariationPct" DECIMAL(9,4),
    "annualisedValue" DECIMAL(18,2),
    "annualisedImpact" DECIMAL(18,2),
    "actualImpact" DECIMAL(18,2),
    "sections" JSONB,
    "submittedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CppRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CppAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CppAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CppSlotAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CppSlotAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CppRequest_referenceNumber_key" ON "CppRequest"("referenceNumber");

-- CreateIndex
CREATE INDEX "CppRequest_workspaceId_initiatedById_status_idx" ON "CppRequest"("workspaceId", "initiatedById", "status");

-- CreateIndex
CREATE INDEX "CppRequest_status_idx" ON "CppRequest"("status");

-- CreateIndex
CREATE INDEX "CppRequest_category_plant_condition_idx" ON "CppRequest"("category", "plant", "condition");

-- CreateIndex
CREATE INDEX "CppAttachment_requestId_idx" ON "CppAttachment"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CppAttachment_requestId_type_key" ON "CppAttachment"("requestId", "type");

-- CreateIndex
CREATE INDEX "CppSlotAssignment_workspaceId_roleKey_scope_idx" ON "CppSlotAssignment"("workspaceId", "roleKey", "scope");

-- CreateIndex
CREATE INDEX "CppSlotAssignment_userId_idx" ON "CppSlotAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CppSlotAssignment_workspaceId_roleKey_scope_userId_key" ON "CppSlotAssignment"("workspaceId", "roleKey", "scope", "userId");

-- AddForeignKey
ALTER TABLE "CppAttachment" ADD CONSTRAINT "CppAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CppRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

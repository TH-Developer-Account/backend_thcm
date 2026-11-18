-- AlterTable
ALTER TABLE "DealerAuditInstance" ADD COLUMN     "cycleId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "reviewerId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "DealerAuditCycle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checklistTemplateId" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodQuarter" INTEGER,
    "periodLabel" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerAuditCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealerAuditCycle_periodLabel_idx" ON "DealerAuditCycle"("periodLabel");

-- CreateIndex
CREATE INDEX "DealerAuditCycle_createdAt_idx" ON "DealerAuditCycle"("createdAt");

-- CreateIndex
CREATE INDEX "DealerAuditInstance_cycleId_idx" ON "DealerAuditInstance"("cycleId");

-- CreateIndex
CREATE INDEX "DealerAuditInstance_reviewerId_status_idx" ON "DealerAuditInstance"("reviewerId", "status");

-- CreateIndex
CREATE INDEX "DealerAuditInstance_status_dueAt_idx" ON "DealerAuditInstance"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "DealerAuditCycle" ADD CONSTRAINT "DealerAuditCycle_checklistTemplateId_fkey" FOREIGN KEY ("checklistTemplateId") REFERENCES "ChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditCycle" ADD CONSTRAINT "DealerAuditCycle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "DealerAuditCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerAuditInstance" ADD CONSTRAINT "DealerAuditInstance_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

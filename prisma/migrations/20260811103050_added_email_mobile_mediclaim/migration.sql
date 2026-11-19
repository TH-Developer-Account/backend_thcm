-- CreateEnum
CREATE TYPE "ClaimCover" AS ENUM ('SELF', 'SPOUSE', 'BOTH');

-- CreateEnum
CREATE TYPE "ClaimHead" AS ENUM ('VISIT_FEES', 'MEDICINES_INVESTIGATIONS', 'OPHTHALMIC_TREATMENT', 'EXECUTIVE_HEALTH_CHECKUP', 'EXCESS_HOSPITALISATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_CLAIM_INITIATED';
ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_CLAIM_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_CLAIM_RESUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_CLAIM_SENT_FOR_APPROVAL';
ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_CLAIM_CLOSED';

-- AlterEnum
ALTER TYPE "WorkflowSubjectType" ADD VALUE 'MEDICAL_CLAIM';

-- CreateTable
CREATE TABLE "MedicalClaim" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiatedById" TEXT NOT NULL,
    "guestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_EX_EMPLOYEE',
    "mobile" TEXT,
    "email" TEXT,
    "ticketNumber" TEXT,
    "grade" TEXT,
    "location" TEXT,
    "employeeName" TEXT,
    "patientName" TEXT,
    "claimCover" "ClaimCover",
    "spouseName" TEXT,
    "medicalAdvanceTaken" DECIMAL(12,2),
    "eligibleAmount" DECIMAL(12,2),
    "alreadySettled" DECIMAL(12,2),
    "totalClaimed" DECIMAL(12,2),
    "declarationAcceptedAt" TIMESTAMP(3),
    "signatureName" TEXT,
    "signatureDate" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicalClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalClaimBill" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "claimHead" "ClaimHead" NOT NULL,
    "billNo" TEXT,
    "billName" TEXT,
    "billDate" TIMESTAMP(3),
    "amount" DECIMAL(12,2) NOT NULL,
    "s3Key" TEXT,

    CONSTRAINT "MedicalClaimBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalClaimGradeEligibility" (
    "id" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "annualCap" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "MedicalClaimGradeEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedicalClaim_referenceNumber_key" ON "MedicalClaim"("referenceNumber");

-- CreateIndex
CREATE INDEX "MedicalClaim_workspaceId_status_idx" ON "MedicalClaim"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MedicalClaim_guestId_idx" ON "MedicalClaim"("guestId");

-- CreateIndex
CREATE INDEX "MedicalClaimBill_claimId_idx" ON "MedicalClaimBill"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicalClaimGradeEligibility_grade_key" ON "MedicalClaimGradeEligibility"("grade");

-- AddForeignKey
ALTER TABLE "MedicalClaim" ADD CONSTRAINT "MedicalClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicalClaim" ADD CONSTRAINT "MedicalClaim_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicalClaim" ADD CONSTRAINT "MedicalClaim_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicalClaimBill" ADD CONSTRAINT "MedicalClaimBill_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "MedicalClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

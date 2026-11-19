-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'VENDOR_ONBOARDING_INITIATED';
ALTER TYPE "ActivityAction" ADD VALUE 'VENDOR_FORM_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'VENDOR_ONBOARDING_SENT_FOR_APPROVAL';
ALTER TYPE "ActivityAction" ADD VALUE 'VENDOR_ONBOARDING_CLOSED';

-- AlterEnum
ALTER TYPE "WorkflowSubjectType" ADD VALUE 'VENDOR_ONBOARDING';

-- CreateTable
CREATE TABLE "VendorOnboarding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiatedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_VENDOR',
    "vendorName" TEXT,
    "state" TEXT,
    "city" TEXT,
    "pinCode" TEXT,
    "address" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "msmeVendor" BOOLEAN,
    "msmeCertAttached" BOOLEAN,
    "bankName" TEXT,
    "bankBranch" TEXT,
    "ifscCode" TEXT,
    "bankAddress" TEXT,
    "accountNumber" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "entityRegNo" TEXT,
    "dpdpConsentedAt" TIMESTAMP(3),
    "dpdpConsentIp" TEXT,
    "vendorSubmittedAt" TIMESTAMP(3),
    "vendorCode" TEXT,
    "vendorType" TEXT,
    "companyCode" TEXT,
    "purchaseOrg" TEXT,
    "paymentTerm" TEXT,
    "tds" TEXT,
    "vendorCategory" TEXT,
    "materialType" TEXT,
    "materialSubType" TEXT,
    "selfAssessmentObtained" BOOLEAN,
    "ndaObtained" BOOLEAN,
    "gpaObtained" BOOLEAN,
    "isRelatedParty" BOOLEAN,
    "vendorAuditReportPrepared" BOOLEAN,
    "natureOfService" TEXT,
    "onboardingReason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOnboardingDocument" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorOnboardingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAccessToken" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOnboarding_workspaceId_status_idx" ON "VendorOnboarding"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "VendorOnboardingDocument_onboardingId_idx" ON "VendorOnboardingDocument"("onboardingId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorOnboardingDocument_onboardingId_documentType_key" ON "VendorOnboardingDocument"("onboardingId", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAccessToken_token_key" ON "VendorAccessToken"("token");

-- CreateIndex
CREATE INDEX "VendorAccessToken_onboardingId_idx" ON "VendorAccessToken"("onboardingId");

-- AddForeignKey
ALTER TABLE "VendorOnboarding" ADD CONSTRAINT "VendorOnboarding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOnboarding" ADD CONSTRAINT "VendorOnboarding_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOnboardingDocument" ADD CONSTRAINT "VendorOnboardingDocument_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "VendorOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAccessToken" ADD CONSTRAINT "VendorAccessToken_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "VendorOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

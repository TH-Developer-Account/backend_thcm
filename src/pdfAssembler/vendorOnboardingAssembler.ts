import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ONBOARDING — DATA ASSEMBLER
//
// Single responsibility: fetch the VendorOnboarding record + its documents
// and shape them into the flat structure the docDefinition builder expects.
// Knows nothing about pdfmake, S3, or rendering.
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorOnboardingPdfData {
  vendor: {
    vendorName: string | null;
    state: string | null;
    city: string | null;
    pinCode: string | null;
    address: string | null;
    mobile: string | null;
    email: string | null;
    msmeVendor: boolean | null;
    msmeCertAttached: boolean | null;
    gstin: string | null;
    pan: string | null;
    entityRegNo: string | null;
    vendorSubmittedAt: Date | null;
  };
  bank: {
    bankName: string | null;
    bankBranch: string | null;
    ifscCode: string | null;
    bankAddress: string | null;
    accountNumber: string | null;
  };
  procurement: {
    vendorCode: string | null;
    vendorType: string | null;
    companyCode: string | null;
    purchaseOrg: string | null;
    paymentTerm: string | null;
    tds: string | null;
    vendorCategory: string | null;
    materialType: string | null;
    materialSubType: string | null;
    natureOfService: string | null;
    onboardingReason: string | null;
    selfAssessmentObtained: boolean | null;
    ndaObtained: boolean | null;
    gpaObtained: boolean | null;
    isRelatedParty: boolean | null;
    vendorAuditReportPrepared: boolean | null;
  };
  documents: Array<{ documentType: string; uploadedAt: Date }>;
  status: string;
  generatedAt: Date;
}

export async function assembleVendorOnboardingPdfData(
  onboardingId: string,
): Promise<VendorOnboardingPdfData> {
  const onboarding = await prisma.vendorOnboarding.findUnique({
    where: { id: onboardingId },
    include: {
      documents: {
        select: { documentType: true, uploadedAt: true },
      },
    },
  });

  if (!onboarding) {
    throw new ApiError(404, "Vendor onboarding record not found");
  }

  return {
    vendor: {
      vendorName: onboarding.vendorName,
      state: onboarding.state,
      city: onboarding.city,
      pinCode: onboarding.pinCode,
      address: onboarding.address,
      mobile: onboarding.mobile,
      email: onboarding.email,
      msmeVendor: onboarding.msmeVendor,
      msmeCertAttached: onboarding.msmeCertAttached,
      gstin: onboarding.gstin,
      pan: onboarding.pan,
      entityRegNo: onboarding.entityRegNo,
      vendorSubmittedAt: onboarding.vendorSubmittedAt,
    },
    bank: {
      bankName: onboarding.bankName,
      bankBranch: onboarding.bankBranch,
      ifscCode: onboarding.ifscCode,
      bankAddress: onboarding.bankAddress,
      accountNumber: onboarding.accountNumber,
    },
    procurement: {
      vendorCode: onboarding.vendorCode,
      vendorType: onboarding.vendorType,
      companyCode: onboarding.companyCode,
      purchaseOrg: onboarding.purchaseOrg,
      paymentTerm: onboarding.paymentTerm,
      tds: onboarding.tds,
      vendorCategory: onboarding.vendorCategory,
      materialType: onboarding.materialType,
      materialSubType: onboarding.materialSubType,
      natureOfService: onboarding.natureOfService,
      onboardingReason: onboarding.onboardingReason,
      selfAssessmentObtained: onboarding.selfAssessmentObtained,
      ndaObtained: onboarding.ndaObtained,
      gpaObtained: onboarding.gpaObtained,
      isRelatedParty: onboarding.isRelatedParty,
      vendorAuditReportPrepared: onboarding.vendorAuditReportPrepared,
    },
    documents: onboarding.documents,
    status: onboarding.status,
    generatedAt: new Date(),
  };
}

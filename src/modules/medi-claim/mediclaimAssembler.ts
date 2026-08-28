import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// MEDICAL CLAIM — PDF DATA ASSEMBLER
//
// Single responsibility: fetch the MedicalClaim record + its bills and shape
// them into the flat structure the docDefinition builder expects. Knows
// nothing about pdfmake, S3, or rendering. Mirrors vendorOnboardingAssembler.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface MedicalClaimPdfData {
  claim: {
    referenceNumber: string;
    employeeName: string | null;
    ticketNumber: string | null;
    mobile: string | null;
    email: string | null;
    grade: string | null;
    location: string | null;
    patientName: string | null;
    claimCover: string | null;
    spouseName: string | null;
    medicalAdvanceTaken: number | null;
    submittedAt: Date | null;
  };
  amounts: {
    eligibleAmount: number | null;
    alreadySettled: number | null;
    totalClaimed: number | null;
  };
  bills: Array<{
    claimHead: string;
    billNo: string | null;
    billName: string | null;
    billDate: Date | null;
    amount: number;
    approvedClaimAmount: number | null;
    approved: boolean;
  }>;
  status: string;
  generatedAt: Date;
}

// Prisma's Decimal fields aren't plain numbers — normalise once here so the
// docDefinition builder only ever deals with `number | null`.
const toNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export async function assembleMedicalClaimPdfData(
  claimId: string,
): Promise<MedicalClaimPdfData> {
  const claim = await prisma.medicalClaim.findUnique({
    where: { id: claimId },
    include: { bills: true },
  });

  if (!claim) {
    throw new ApiError(404, "Medical claim record not found");
  }

  return {
    claim: {
      referenceNumber: claim.referenceNumber,
      employeeName: claim.employeeName,
      ticketNumber: claim.ticketNumber,
      mobile: claim.mobile,
      email: claim.email,
      grade: claim.grade,
      location: claim.location,
      patientName: claim.patientName,
      claimCover: claim.claimCover,
      spouseName: claim.spouseName,
      medicalAdvanceTaken: toNumber(claim.medicalAdvanceTaken),
      submittedAt: claim.submittedAt,
    },
    amounts: {
      eligibleAmount: toNumber(claim.eligibleAmount),
      alreadySettled: toNumber(claim.alreadySettled),
      totalClaimed: toNumber(claim.totalClaimed),
    },
    bills: claim.bills.map((bill) => ({
      claimHead: bill.claimHead,
      billNo: bill.billNo,
      billName: bill.billName,
      billDate: bill.billDate,
      amount: toNumber(bill.amount) as number,
      approvedClaimAmount: toNumber(bill.approvedClaimAmount),
      approved: bill.approved,
    })),
    status: claim.status,
    generatedAt: new Date(),
  };
}

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  SETTLED_CLAIM_STATUSES,
  approvedPaise,
  isHospitalisationHead,
  toPaise,
} from "./mediclaim.eligibility";

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
    // Non-hospitalisation bucket (every grade).
    eligibleAmount: number | null;
    alreadySettled: number | null;
    // Hospitalisation bucket — null for grades without hospitalisation cover.
    hospitalisationEligibleAmount: number | null;
    hospitalisationAlreadySettled: number | null;
    totalClaimed: number | null;
    // Split of totalClaimed, computed from the bills.
    claimedNonHospitalisation: number;
    claimedHospitalisation: number;
    // Sum of approved amounts; null while nothing has been approved yet.
    totalApproved: number | null;
  };
  bills: Array<{
    claimHead: string;
    billNo: string | null;
    billName: string | null;
    billDate: Date | null;
    amount: number;
    // The amount the approver accepted. For a settled claim a line approved
    // without a typed amount shows its claimed amount; null = not reviewed yet.
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

  const isSettled = (SETTLED_CLAIM_STATUSES as readonly string[]).includes(
    claim.status,
  );

  // Paise throughout, rupees once at the end — no float drift in the totals.
  let claimedHospitalisationPaise = 0;
  let claimedNonHospitalisationPaise = 0;
  let approvedTotalPaise = 0;
  let anyApproved = false;

  const bills = claim.bills.map((bill) => {
    const claimedPaise = toPaise(bill.amount);
    if (isHospitalisationHead(bill.claimHead)) {
      claimedHospitalisationPaise += claimedPaise;
    } else {
      claimedNonHospitalisationPaise += claimedPaise;
    }

    // On a settled claim every line counts (a line approved without a typed
    // amount is approved at the claimed amount); before that, only lines the
    // approver has actually approved show an approved amount.
    const hasApprovedAmount = isSettled || bill.approved;
    if (hasApprovedAmount) {
      anyApproved = true;
      approvedTotalPaise += approvedPaise(bill);
    }

    return {
      claimHead: bill.claimHead,
      billNo: bill.billNo,
      billName: bill.billName,
      billDate: bill.billDate,
      amount: claimedPaise / 100,
      approvedClaimAmount: hasApprovedAmount ? approvedPaise(bill) / 100 : null,
      approved: isSettled || bill.approved,
    };
  });

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
      hospitalisationEligibleAmount: toNumber(claim.hospitalisationEligibleAmount),
      hospitalisationAlreadySettled: toNumber(claim.hospitalisationAlreadySettled),
      totalClaimed: toNumber(claim.totalClaimed),
      claimedNonHospitalisation: claimedNonHospitalisationPaise / 100,
      claimedHospitalisation: claimedHospitalisationPaise / 100,
      totalApproved: anyApproved ? approvedTotalPaise / 100 : null,
    },
    bills,
    status: claim.status,
    generatedAt: new Date(),
  };
}

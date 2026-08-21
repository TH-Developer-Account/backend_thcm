import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "@shared/config/prisma";
import { addMailJob } from "@mail/mail.service";
import ApiError from "@shared/utils/apiError";
import { uploadToS3, deleteReportImage } from "@shared/utils/aws-s3.services";
import { APP_KEY } from "./mediclaim.routes";

type Tx = Prisma.TransactionClient;

// ── constants ──────────────────────────────────────────────────────────────
const CLAIM_INITIATION_STATUS = "AWAITING_EX_EMPLOYEE";

const INITIATION_SEARCH_FIELDS = ["employeeName", "email", "mobile"] as const;
const CLAIM_SEARCH_FIELDS = [
  "employeeName",
  "ticketNumber",
  "referenceNumber",
] as const;

export interface MedicalClaimBillInputRaw {
  id?: string;
  claimHead: string;
  billNo?: string;
  billName?: string;
  billDate?: string;
  amount: number;
  attachmentIndex?: number | null; // may be missing/null before validation
}

export type MedicalClaimListingTab =
  | "initiation"
  | "claims"
  | "pendingOnMe"
  | "approvedByMe";

export async function resolveMedicalClaimSubjectIdsForApprovalTab(
  userId: string,
  tab: Extract<MedicalClaimListingTab, "pendingOnMe" | "approvedByMe">,
): Promise<string[]> {
  const approvals = await prisma.approval.findMany({
    where: {
      approverId: userId,
      status: tab === "pendingOnMe" ? "PENDING" : "APPROVED",
      stage: {
        workflow: { subjectType: "MEDICAL_CLAIM", isActive: true },
        ...(tab === "pendingOnMe"
          ? { isCurrentIteration: true, status: "IN_PROGRESS" }
          : {}),
      },
    },
    select: {
      stage: { select: { workflow: { select: { subjectId: true } } } },
    },
  });

  return [...new Set(approvals.map((a) => a.stage.workflow.subjectId))];
}

export const buildMedicalClaimWhereClause = (
  workspaceId: string,
  userId: string,
  tab: MedicalClaimListingTab,
  search: string,
  approvalSubjectIds?: string[],
) => {
  const searchableFields =
    tab === "initiation" ? INITIATION_SEARCH_FIELDS : CLAIM_SEARCH_FIELDS;

  const searchFilter = search
    ? {
        OR: searchableFields.map((field) => ({
          [field]: { contains: search, mode: "insensitive" as const },
        })),
      }
    : {};

  if (tab === "pendingOnMe" || tab === "approvedByMe") {
    return {
      workspaceId,
      id: { in: approvalSubjectIds ?? [] },
      ...searchFilter,
    };
  }

  const statusFilter =
    tab === "initiation"
      ? { status: CLAIM_INITIATION_STATUS }
      : { status: { not: CLAIM_INITIATION_STATUS } };

  return {
    workspaceId,
    initiatedById: userId,
    ...statusFilter,
    ...searchFilter,
  };
};

export const parseMedicalClaimListingPaginationParams = (
  page_index: string,
  page_size: string,
) => {
  const reqPageIndex = Math.max(0, parseInt(page_index as string, 10) || 0);
  const reqPageSize = Math.min(
    100,
    Math.max(1, parseInt(page_size as string, 10) || 10),
  );

  return { reqPageIndex, reqPageSize };
};

// ── sorting ──────────────────────────────────────────────────────────────

// Maps each whitelisted sortBy key (as sent by the frontend) to the actual
// Prisma field to order by. A whitelist — not raw pass-through — because an
// unrecognized key handed straight to Prisma's `orderBy` would throw at the
// DB layer; unknown keys fall back to the default safely. Mirrors
// resolveVendorListingOrderBy in vendorOnboarding.helper.ts.
const MEDICAL_CLAIM_SORT_FIELD_MAP: Record<string, string> = {
  employeeName: "employeeName",
  ticketNumber: "ticketNumber",
  referenceNumber: "referenceNumber",
  status: "status",
  created_at: "created_at",
  updated_at: "updated_at",
};

const DEFAULT_MEDICAL_CLAIM_SORT_FIELD = "created_at";
const DEFAULT_MEDICAL_CLAIM_SORT_ORDER = "desc";

// Resolves raw sortBy/sortOrder query values into a Prisma-safe `orderBy`
// object. Kept pure so it can be unit-tested without mocking Express/Prisma.
export const resolveMedicalClaimListingOrderBy = (
  sortBy: string | undefined,
  sortOrder: string | undefined,
): Record<string, "asc" | "desc"> => {
  const field =
    MEDICAL_CLAIM_SORT_FIELD_MAP[sortBy ?? ""] ??
    DEFAULT_MEDICAL_CLAIM_SORT_FIELD;

  const direction =
    sortOrder === "asc" || sortOrder === "desc"
      ? sortOrder
      : DEFAULT_MEDICAL_CLAIM_SORT_ORDER;

  return { [field]: direction };
};

// Format: MED-<4-letter employee code>-<timestamp>, e.g. MED-SYED-20260811143205
// Mirrors generateVendorOnboardingReferenceNumber exactly.
export function generateMedicalClaimReferenceNumber(
  employeeName: string,
): string {
  const letters = employeeName.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const code = (letters + "XXXX").slice(0, 4);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);

  return `MED-${code}-${timestamp}`;
}

// Server-side only — never trust a client-submitted eligible/settled amount.
// Shared between submitMedicalClaimForm and resubmitGuestMedicalClaim so the
// calculation can't drift between the two call sites.
export async function computeMedicalClaimEligibility(
  tx: Tx,
  guestId: string,
  grade: string,
  excludeClaimId?: string,
) {
  const eligibility = await tx.medicalClaimGradeEligibility.findUnique({
    where: { grade },
  });
  if (!eligibility) return null;

  const currentYearStart = new Date(new Date().getFullYear(), 0, 1);
  const priorApprovedBills = await tx.medicalClaimBill.aggregate({
    where: {
      claim: {
        guestId,
        status: "APPROVED",
        created_at: { gte: currentYearStart },
        ...(excludeClaimId ? { id: { not: excludeClaimId } } : {}),
      },
    },
    _sum: { approvedClaimAmount: true },
  });
  const alreadySettled = Number(
    priorApprovedBills._sum.approvedClaimAmount ?? 0,
  );
  const eligibleAmount = Number(eligibility.annualCap) - alreadySettled;

  return { eligibleAmount, alreadySettled };
}

// Called from workflowSubject.helper's postClarifyHooks when an approver
// clarifies a MEDICAL_CLAIM — the only path back to the ex-employee.
export async function notifyGuestOfClarification(
  tx: Tx,
  claimId: string,
): Promise<void> {
  const claim = await tx.medicalClaim.findUnique({
    where: { id: claimId },
    select: {
      guestId: true,
      referenceNumber: true,
      email: true,
      employeeName: true,
    },
  });
  if (!claim?.guestId) return;

  const latestClarification = await prisma.activityLog.findFirst({
    where: {
      subjectType: APP_KEY,
      subjectId: claimId,
      action: "CLARIFY",
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true, createdAt: true },
  });

  await addMailJob({
    to: claim.email as string,
    subject: "Medical Claim — Clarification Requested",
    templateName: "medical-claim-clarification",
    templateData: {
      employeeName: claim.employeeName,
      claimReference: claim.referenceNumber,
      clarificationReason:
        (latestClarification?.metadata as { reason?: string } | null)?.reason ??
        null,
      formUrl: `${process.env.FRONTEND_URL}/guest/login`,
    },
  });
}

// Bills can carry any common receipt/photo format — broader than vendor
// onboarding's fixed cert types, so this stays local rather than importing
// the vendor-doc-specific mime map.
const BILL_ATTACHMENT_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function getBillAttachmentExtension(mimetype: string): string {
  return BILL_ATTACHMENT_EXTENSIONS_BY_MIME_TYPE[mimetype] ?? "bin";
}

// Shared bill upsert for draft/submit/resubmit. Bills are matched by id —
// present + belonging to this claim ⇒ update in place (preserving the
// existing S3 attachment if no new file is sent this round); otherwise
// created fresh. Bills removed from the payload (present in DB, absent
// here) are deleted along with their S3 object. requireAttachment governs
// whether a bill needs SOME attachment (new file or a pre-existing one) —
// false for drafts (partial saves are expected), true for submit/resubmit.
export const upsertMedicalClaimBills = async (
  tx: Tx,
  claimId: string,
  bills: MedicalClaimBillInputRaw[],
  files: Express.Multer.File[],
  options: { requireAttachment: boolean },
): Promise<number> => {
  const existingBills = await tx.medicalClaimBill.findMany({
    where: { claimId },
    select: { id: true, s3Key: true },
  });
  const existingIds = new Set(existingBills.map((b) => b.id));
  const s3KeyById = new Map(existingBills.map((b) => [b.id, b.s3Key]));
  const keptIds = new Set<string>();

  if (options.requireAttachment) {
    bills.forEach((bill, index) => {
      const isExisting = Boolean(bill.id && existingIds.has(bill.id));
      const previousS3Key = isExisting
        ? (s3KeyById.get(bill.id!) ?? null)
        : null;
      const hasNewFile =
        bill.attachmentIndex != null && Boolean(files[bill.attachmentIndex]);

      if (!hasNewFile && !previousS3Key) {
        throw new ApiError(
          400,
          `An attachment is required for bill #${index + 1} (${bill.claimHead})`,
        );
      }
    });
  }

  for (const [index, bill] of bills.entries()) {
    const isExisting = Boolean(bill.id && existingIds.has(bill.id));
    const previousS3Key = isExisting ? (s3KeyById.get(bill.id!) ?? null) : null;
    const file =
      bill.attachmentIndex != null ? files[bill.attachmentIndex] : undefined;

    let s3Key: string | null = previousS3Key;
    if (file) {
      const extension = getBillAttachmentExtension(file.mimetype);
      s3Key = `medical-claim-bills/${claimId}/${index}-${bill.claimHead}.${extension}`;
      await uploadToS3(s3Key, file.buffer, file.mimetype);

      if (previousS3Key && previousS3Key !== s3Key) {
        await deleteReportImage(previousS3Key);
      }
    }

    const data = {
      claimId,
      claimHead: bill.claimHead as any,
      billNo: bill.billNo,
      billName: bill.billName,
      billDate: bill.billDate ? new Date(bill.billDate) : null,
      amount: bill.amount,
      s3Key,
    };

    if (isExisting) {
      await tx.medicalClaimBill.update({ where: { id: bill.id }, data });
      keptIds.add(bill.id!);
    } else {
      const created = await tx.medicalClaimBill.create({ data });
      keptIds.add(created.id);
    }
  }

  const toDelete = existingBills.filter((b) => !keptIds.has(b.id));
  if (toDelete.length) {
    await tx.medicalClaimBill.deleteMany({
      where: { id: { in: toDelete.map((b) => b.id) } },
    });
    await Promise.all(
      toDelete
        .filter((b) => b.s3Key)
        .map((b) => deleteReportImage(b.s3Key as string)),
    );
  }

  return bills.reduce((sum, b) => sum + Number(b.amount), 0);
};

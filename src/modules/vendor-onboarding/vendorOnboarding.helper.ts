import { prisma } from "@shared/config/prisma";
import { VendorOnboarding } from "../../prisma/generated/prisma/client";
import { CsvRow } from "@import-export/utils/csvWriter";

interface Approver {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
}

interface Approval {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | string;
  isExternalApprover: boolean;
  approver: Approver;
}

interface Stage {
  id: string;
  workflowId: string;
  stageOrder: number;
  stageName: string;
  iteration: number;
  isCurrentIteration: boolean;
  strategy: "ALL" | "ANY" | string;
  minApprovals: number | null;
  startedAt: string | null;
  dueAt: string | null;
  escalatedTo: string | null;
  status: "PENDING" | "IN_PROGRESS" | "APPROVED" | "REJECTED" | string;
  approvals: Approval[];
}

interface WorkflowObject {
  id: string;
  templateId: string;
  workspaceId: string;
  iteration: number;
  isActive: boolean;
  workflowType: string;
  status: string;
  currentStage: number;
  appId: string;
  subjectType: string;
  subjectId: string;
  created_at: string;
  updated_at: string;
  template: {
    id: string;
    name: string;
    description: string;
    metaData_1: string;
  };
  stages: Stage[];
}

// ── constants ──────────────────────────────────────────────────────────────

const ONBOARDING_SEARCH_FIELDS = [
  "vendorName",
  "vendorCode",
  "vendorType",
  "companyCode",
  "email",
  "mobile",
] as const;

export type VendorListingTab =
  | "initiation"
  | "onboarding"
  | "pendingOnMe"
  | "approvedByMe";

// ── pure helpers ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// resolveSubjectIdsForApprovalTab
//
// Mirrors searchEventProposal.helper's pendingOnMe/approvedByMe EXISTS logic,
// just expressed as "find matching subjectIds, then filter by id: { in }"
// instead of raw SQL — VendorOnboarding has no direct Prisma relation to
// WorkflowInstance (same loose subjectType/subjectId pairing as everywhere
// else), so this is the Prisma-native equivalent of that EXISTS subquery.
//
// pendingOnMe   → PENDING approval, current iteration, stage IN_PROGRESS
// approvedByMe  → APPROVED approval, any iteration (past approvals are still
//                 real history — same reasoning as EPC's version)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveSubjectIdsForApprovalTab(
  userId: string,
  tab: Extract<VendorListingTab, "pendingOnMe" | "approvedByMe">,
): Promise<string[]> {
  const approvals = await prisma.approval.findMany({
    where: {
      approverId: userId,
      status: tab === "pendingOnMe" ? "PENDING" : "APPROVED",
      stage: {
        workflow: { subjectType: "VENDOR_ONBOARDING", isActive: true },
        ...(tab === "pendingOnMe"
          ? { isCurrentIteration: true, status: "IN_PROGRESS" }
          : {}),
      },
    },
    select: {
      stage: { select: { workflow: { select: { subjectId: true } } } },
    },
  });

  // dedupe — a subject could theoretically surface more than once across
  // stages/iterations for approvedByMe
  return [...new Set(approvals.map((a) => a.stage.workflow.subjectId))];
}

// Builds the Prisma `where` clause for any listing tab. Kept pure (no req/res)
// so the filtering rules can be unit-tested without mocking Express or Prisma.
//
// approvalSubjectIds is only populated by the controller for
// pendingOnMe/approvedByMe — passed in rather than queried here, so this
// function stays synchronous and side-effect-free like the rest of the file.
export const buildVendorOnboardingWhereClause = (
  workspaceId: string,
  userId: string,
  tab: VendorListingTab,
  search: string,
  approvalSubjectIds?: string[],
) => {
  const searchableFields = ONBOARDING_SEARCH_FIELDS;

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

  return {
    workspaceId,
    initiatedById: userId,
    ...searchFilter,
  };
};

// Clamped so a malformed or malicious query string can't request page sizes
// large enough to be a denial-of-service vector against the DB.
export const parseVendorListingPaginationParams = (
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

// ── draft visibility ─────────────────────────────────────────────────────

// While status is AWAITING_VENDOR, the vendor may have partially filled the
// form via saveVendorFormDraft (or not started at all) — either way nothing
// past the initial contact fields has been submitted yet, so it shouldn't be
// visible to staff. vendorName/email/mobile stay visible since those are set
// at initiation time, not by the vendor's draft. Kept pure so the masking
// rule can be unit-tested without mocking Express/Prisma.
export const maskUnsubmittedVendorOnboardingFields = <
  T extends Record<string, unknown>,
>(
  onboarding: T,
): T => ({
  ...onboarding,
  state: null,
  city: null,
  pinCode: null,
  address: null,
  msmeVendor: null,
  bankName: null,
  bankBranch: null,
  ifscCode: null,
  bankAddress: null,
  accountNumber: null,
  gstin: null,
  pan: null,
  entityRegNo: null,
  vendorSubmittedAt: null,
});

// ── sorting ──────────────────────────────────────────────────────────────

// Maps each whitelisted sortBy key (as sent by the frontend) to the actual
// Prisma field to order by. A whitelist — not raw pass-through — because an
// unrecognized or relation-shaped key handed straight to Prisma's `orderBy`
// would throw at the DB layer; unknown keys fall back to the default safely.
const VENDOR_LISTING_SORT_FIELD_MAP: Record<string, string> = {
  referenceNumber: "referenceNumber",
  vendorName: "vendorName",
  vendorCode: "vendorCode",
  vendorType: "vendorType",
  companyCode: "companyCode",
  status: "status",
  created_at: "created_at",
  updated_at: "updated_at",
};

const DEFAULT_VENDOR_LISTING_SORT_FIELD = "created_at";
const DEFAULT_VENDOR_LISTING_SORT_ORDER = "desc";

// Resolves raw sortBy/sortOrder query values into a Prisma-safe `orderBy`
// object. Kept pure so it can be unit-tested without mocking Express/Prisma.
export const resolveVendorListingOrderBy = (
  sortBy: string | undefined,
  sortOrder: string | undefined,
): Record<string, "asc" | "desc"> => {
  const field =
    VENDOR_LISTING_SORT_FIELD_MAP[sortBy ?? ""] ??
    DEFAULT_VENDOR_LISTING_SORT_FIELD;

  const direction =
    sortOrder === "asc" || sortOrder === "desc"
      ? sortOrder
      : DEFAULT_VENDOR_LISTING_SORT_ORDER;

  return { [field]: direction };
};

// ─────────────────────────────────────────────────────────────────────────────
// generateVendorOnboardingReferenceNumber
//
// Format: VON-<4-letter vendor code>-<timestamp>
//   e.g. VON-RAJE-20260720143205
//
// The 4-letter segment is derived from vendorName (letters only, uppercased,
// padded with X if the name is shorter than 4 letters) — purely cosmetic,
// NOT the uniqueness guarantee. Uniqueness comes from the timestamp +
// the referenceNumber's @unique constraint on VendorOnboarding; a same-
// millisecond collision is practically impossible for this app's traffic,
// but the DB constraint means a theoretical collision fails loudly (P2002)
// rather than silently overwriting/duplicating.
// ─────────────────────────────────────────────────────────────────────────────

export function generateVendorOnboardingReferenceNumber(
  vendorName: string,
): string {
  const letters = vendorName.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const vendorCode = (letters + "XXXX").slice(0, 4);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14); // YYYYMMDDHHmmss

  return `VON-${vendorCode}-${timestamp}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// mapVendorOnboardingToXlsxRow
//
// Single source of truth for "what does a VendorOnboarding row look like in
// an export file". Used by both the single-record export
// (exportVendorOnboardingById) and the bulk export
// (vendorOnboardingExport.service.ts) — previously this field list was
// duplicated inline in the single-record controller, which would have
// silently drifted from the bulk export's row shape over time.
// ─────────────────────────────────────────────────────────────────────────────

export function mapVendorOnboardingToXlsxRow(
  onboarding: VendorOnboarding,
): CsvRow {
  return {
    "Reference Number": onboarding.referenceNumber,
    Status: onboarding.status,
    "Vendor Name": onboarding.vendorName ?? "",
    State: onboarding.state ?? "",
    City: onboarding.city ?? "",
    "Pin Code": onboarding.pinCode ?? "",
    Address: onboarding.address ?? "",
    Mobile: onboarding.mobile ?? "",
    Email: onboarding.email ?? "",
    "MSME Vendor": onboarding.msmeVendor ?? "",
    "Bank Name": onboarding.bankName ?? "",
    "Bank Branch": onboarding.bankBranch ?? "",
    "IFSC Code": onboarding.ifscCode ?? "",
    "Bank Address": onboarding.bankAddress ?? "",
    "Account Number": onboarding.accountNumber ?? "",
    GSTIN: onboarding.gstin ?? "",
    PAN: onboarding.pan ?? "",
    "Entity Reg No": onboarding.entityRegNo ?? "",
    "Vendor Submitted At": onboarding.vendorSubmittedAt?.toISOString() ?? "",
    "Vendor Code": onboarding.vendorCode ?? "",
    "Vendor Type": onboarding.vendorType ?? "",
    "Company Code": onboarding.companyCode ?? "",
    "Purchase Org": onboarding.purchaseOrg ?? "",
    "Payment Term": onboarding.paymentTerm ?? "",
    TDS: onboarding.tds ?? "",
    "Vendor Category": onboarding.vendorCategory ?? "",
    "Material Type": onboarding.materialType ?? "",
    "Material Sub Type": onboarding.materialSubType ?? "",
    "Self Assessment Obtained": onboarding.selfAssessmentObtained ?? "",
    "NDA Obtained": onboarding.ndaObtained ?? "",
    "GPA Obtained": onboarding.gpaObtained ?? "",
    "Is Related Party": onboarding.isRelatedParty ?? "",
    "Vendor Audit Report Prepared": onboarding.vendorAuditReportPrepared ?? "",
    "Nature Of Service": onboarding.natureOfService ?? "",
    "Onboarding Reason": onboarding.onboardingReason ?? "",
    "Created At": onboarding.created_at.toISOString(),
    "Updated At": onboarding.updated_at.toISOString(),
  };
}

// Column width hints shared by both export paths — kept alongside the row
// mapper so the two stay in sync (adding a field to one is a strong signal
// to check the other).
export const VENDOR_ONBOARDING_EXPORT_COLUMN_WIDTHS: Record<string, number> = {
  "Reference Number": 24,
  "Vendor Name": 25,
  Address: 35,
  Email: 28,
  "Bank Address": 30,
  "Entity Reg No": 20,
  "Onboarding Reason": 30,
export const isExternalApproverInWorkflow = (
  workflow: WorkflowObject,
  userId: string,
): boolean => {
  for (const stage of workflow.stages) {
    const approval = stage.approvals.find((a) => a.approver.id === userId);
    if (approval) {
      return approval.isExternalApprover === true;
    }
  }
  return false; // userId not found among approvers at all
};

import { prisma } from "../config/prisma";

// ── constants ──────────────────────────────────────────────────────────────
const VENDOR_INITIATION_STATUS = "AWAITING_VENDOR";

const INITIATION_SEARCH_FIELDS = ["vendorName", "email", "mobile"] as const;
const ONBOARDING_SEARCH_FIELDS = [
  "vendorName",
  "vendorCode",
  "vendorType",
  "companyCode",
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
  const searchableFields =
    tab === "initiation" ? INITIATION_SEARCH_FIELDS : ONBOARDING_SEARCH_FIELDS;

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
      ? { status: VENDOR_INITIATION_STATUS }
      : { status: { not: VENDOR_INITIATION_STATUS } };

  return {
    workspaceId,
    initiatedById: userId,
    ...statusFilter,
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

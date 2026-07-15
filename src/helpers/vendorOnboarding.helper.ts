// ── constants ──────────────────────────────────────────────────────────────
const VENDOR_INITIATION_STATUS = "AWAITING_VENDOR";

const INITIATION_SEARCH_FIELDS = ["vendorName", "email", "mobile"] as const;
const ONBOARDING_SEARCH_FIELDS = [
  "vendorName",
  "vendorCode",
  "vendorType",
  "companyCode",
] as const;

export type VendorListingTab = "initiation" | "onboarding";

// ── pure helpers ─────────────────────────────────────────────────────────────

// Builds the Prisma `where` clause for either listing tab. Kept pure (no req/res)
// so the filtering rules can be unit-tested without mocking Express or Prisma.
export const buildVendorOnboardingWhereClause = (
  workspaceId: string,
  userId: string,
  tab: VendorListingTab,
  search: string,
) => {
  const statusFilter =
    tab === "initiation"
      ? { status: VENDOR_INITIATION_STATUS }
      : { status: { not: VENDOR_INITIATION_STATUS } };

  const searchableFields =
    tab === "initiation" ? INITIATION_SEARCH_FIELDS : ONBOARDING_SEARCH_FIELDS;

  const searchFilter = search
    ? {
        OR: searchableFields.map((field) => ({
          [field]: { contains: search, mode: "insensitive" as const },
        })),
      }
    : {};

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

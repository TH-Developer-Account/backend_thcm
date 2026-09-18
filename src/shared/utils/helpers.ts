import { Prisma } from "../../prisma/generated/prisma/client";

// Shared offset-pagination parser for list endpoints. Clamps to sane bounds
// so a missing/garbage query param can't turn into an unbounded findMany.
export function parsePaginationParams(
  pageIndex: string | undefined,
  pageSize: string | undefined,
) {
  const reqPageIndex = Math.max(0, parseInt(pageIndex as string, 10) || 0);
  const reqPageSize = Math.min(
    100,
    Math.max(1, parseInt(pageSize as string, 10) || 20),
  );

  return { reqPageIndex, reqPageSize };
}

// Turns a set of "if present in query, filter by exact match" params into
// Prisma AND-clause conditions. Only handles plain equality on scalar
// columns — relation lookups (like profile-by-name) don't fit this shape
// and should stay hand-written alongside it.
export function buildEqualityFilters(
  query: Record<string, unknown>,
  fields: string[],
): Record<string, unknown>[] {
  return fields
    .filter((field) => query[field] !== undefined && query[field] !== "")
    .map((field) => ({ [field]: query[field] }));
}

export const businessPartnerSelect = {
  id: true,
  bpName: true,
  bpShortName: true,
  bpType: true,
  officeType: true,
  vendorCode: true,
} satisfies Prisma.BusinessPartnerSelect;

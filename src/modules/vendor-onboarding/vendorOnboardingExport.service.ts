import { prisma } from "@shared/config/prisma";
import { rowsToCsvBuffer } from "@import-export/utils/csvWriter";
import { buildXlsxBuffer } from "@import-export/utils/xlsxWriter";
import { uploadBufferToS3 } from "@shared/utils/aws-s3.services";
import {
  buildVendorOnboardingWhereClause,
  mapVendorOnboardingToXlsxRow,
  VENDOR_ONBOARDING_EXPORT_COLUMN_WIDTHS,
  VendorListingTab,
} from "./vendorOnboarding.helper";

// ─────────────────────────────────────────────────────────────────────────────
// vendorOnboardingExport.service.ts
//
// Bulk export counterpart to exportVendorOnboardingById — same row shape
// (via mapVendorOnboardingToXlsxRow), but for every record matching the
// current list filters instead of a single id.
//
// WHY a plain findMany and not epcExport.service.ts's cursor-batched
// approach: vendor onboarding is workspace-scoped with no deep joins (unlike
// the EPC dump's line items + workflow stages across potentially tens of
// thousands of rows). A single findMany here stays well within safe memory
// bounds for this app's actual volume — cursor-batching would be premature
// optimization for a dataset this shape. If that assumption stops holding,
// this is the function to revisit.
// ─────────────────────────────────────────────────────────────────────────────

export type VendorOnboardingExportFilters = {
  workspaceId: string;
  userId: string;
  tab: VendorListingTab;
  search: string;
  approvalSubjectIds?: string[];
};

export type VendorOnboardingExportResult = {
  s3Key: string;
  filename: string;
  totalRecords: number;
};

async function fetchVendorOnboardingsForExport(
  filters: VendorOnboardingExportFilters,
) {
  const where = buildVendorOnboardingWhereClause(
    filters.workspaceId,
    filters.userId,
    filters.tab,
    filters.search,
    filters.approvalSubjectIds,
  );

  return prisma.vendorOnboarding.findMany({
    where,
    orderBy: { created_at: "desc" },
  });
}

export async function exportVendorOnboardingsToS3(
  filters: VendorOnboardingExportFilters,
  format: "csv" | "xlsx",
): Promise<VendorOnboardingExportResult> {
  const onboardings = await fetchVendorOnboardingsForExport(filters);
  const rows = onboardings.map(mapVendorOnboardingToXlsxRow);

  const timestamp = new Date().toISOString().slice(0, 10);

  let buffer: Buffer;
  let filename: string;

  if (format === "csv") {
    buffer = rowsToCsvBuffer(rows);
    filename = `vendor-onboarding-${filters.tab}-${timestamp}.csv`;
  } else {
    buffer = buildXlsxBuffer([
      {
        name: "VendorOnboarding",
        rows,
        columnWidths: VENDOR_ONBOARDING_EXPORT_COLUMN_WIDTHS,
      },
    ]);
    filename = `vendor-onboarding-${filters.tab}-${timestamp}.xlsx`;
  }

  const s3Key = `exports/vendor-onboarding/${filename}`;
  await uploadBufferToS3(s3Key, buffer, filename);

  return { s3Key, filename, totalRecords: onboardings.length };
}

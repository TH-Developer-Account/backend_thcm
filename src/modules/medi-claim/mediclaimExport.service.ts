import { prisma } from "@shared/config/prisma";
import { rowsToCsvBuffer, toCsvRow } from "@import-export/utils/csvWriter";
import { buildXlsxBuffer } from "@import-export/utils/xlsxWriter";
import { uploadBufferToS3 } from "@shared/utils/aws-s3.services";
import {
  buildMedicalClaimWhereClause,
  mapMedicalClaimToXlsxRow,
  MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS,
  MedicalClaimListingTab,
} from "./mediclaim.helper";

// ─────────────────────────────────────────────────────────────────────────────
// mediclaimExport.service.ts
//
// Bulk export counterpart to exportMedicalClaimById — same row shape (via
// mapMedicalClaimToXlsxRow), but for every record matching the current
// list filters instead of a single id.
//
// WHY a plain findMany and not epcExport.service.ts's cursor-batched
// approach: same reasoning as vendorOnboardingExport.service.ts — medical
// claims are workspace-scoped with no deep joins, well within safe memory
// bounds for this app's actual volume. Revisit if that assumption stops
// holding.
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalClaimExportFilters = {
  workspaceId: string;
  userId: string;
  tab: MedicalClaimListingTab;
  search: string;
  approvalSubjectIds?: string[];
};

export type MedicalClaimExportResult = {
  s3Key: string;
  filename: string;
  totalRecords: number;
};

async function fetchMedicalClaimsForExport(filters: MedicalClaimExportFilters) {
  const where = buildMedicalClaimWhereClause(
    filters.workspaceId,
    filters.userId,
    filters.tab,
    filters.search,
    filters.approvalSubjectIds,
  );

  return prisma.medicalClaim.findMany({
    where,
    orderBy: { created_at: "desc" },
  });
}

export async function exportMedicalClaimsToS3(
  filters: MedicalClaimExportFilters,
  format: "csv" | "xlsx",
): Promise<MedicalClaimExportResult> {
  const claims = await fetchMedicalClaimsForExport(filters);
  const rows = claims.map(mapMedicalClaimToXlsxRow);

  const timestamp = new Date().toISOString().slice(0, 10);

  let buffer: Buffer;
  let filename: string;

  if (format === "csv") {
    buffer = rowsToCsvBuffer(rows.map(toCsvRow));
    filename = `medical-claims-${filters.tab}-${timestamp}.csv`;
  } else {
    buffer = buildXlsxBuffer([
      {
        name: "MedicalClaims",
        rows,
        columnWidths: MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS,
      },
    ]);
    filename = `medical-claims-${filters.tab}-${timestamp}.xlsx`;
  }

  const s3Key = `exports/medical-claims/${filename}`;
  await uploadBufferToS3(s3Key, buffer, filename);

  return { s3Key, filename, totalRecords: claims.length };
}

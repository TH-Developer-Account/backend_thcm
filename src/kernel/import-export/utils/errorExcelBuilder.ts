import { buildXlsxBuffer } from "./xlsxWriter";
import { uploadBufferToS3 } from "@shared/utils/aws-s3.services";
import { RawRow } from "./fileParser";
import { RowError } from "@leads/leadImport.services";

// ─────────────────────────────────────────────────────────────────────────────
// errorExcelBuilder.ts
//
// Builds a "failed rows" XLSX file from an import run and uploads it to S3.
//
// The output mirrors the original file columns with an appended "Errors"
// column that concatenates all validation messages for that row.
// This lets the user fix the file and re-import without guessing which
// rows failed or why.
//
// WHY group errors by row before building the sheet:
//   A single row can have multiple RowErrors (e.g. invalid email AND missing
//   phone). We join them into one cell so each row appears exactly once.
// ─────────────────────────────────────────────────────────────────────────────

// Groups all RowErrors by their 1-based row number into a lookup map
function groupErrorsByRow(errors: RowError[]): Map<number, string[]> {
  const errorsByRow = new Map<number, string[]>();

  for (const error of errors) {
    const existing = errorsByRow.get(error.row) ?? [];
    existing.push(`[${error.field}] ${error.message}`);
    errorsByRow.set(error.row, existing);
  }

  return errorsByRow;
}

// Builds the error sheet rows: original data + "Errors" column
// rowIndex is 0-based (parser output); displayRow = rowIndex + 2 (1-based + header)
function buildErrorRows(
  allRawRows: RawRow[],
  errors: RowError[],
): Record<string, string>[] {
  const errorsByRow = groupErrorsByRow(errors);
  const failedRowNumbers = new Set(errorsByRow.keys());

  const errorRows: Record<string, string>[] = [];

  for (let i = 0; i < allRawRows.length; i++) {
    const displayRow = i + 2; // matches the displayRow calculation in validateRow
    if (!failedRowNumbers.has(displayRow)) continue;

    const raw = allRawRows[i];
    const errorMessages = errorsByRow.get(displayRow)!;

    errorRows.push({
      ...Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [key, String(value ?? "")]),
      ),
      Errors: errorMessages.join("; "),
    });
  }

  return errorRows;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type BuildErrorExcelOptions = {
  epcId: string;
  logId: string;
  allRawRows: RawRow[];
  errors: RowError[];
};

// Returns the S3 key where the error file was uploaded, or null if there are
// no errors (caller should check errors.length before calling, but we guard
// defensively so the worker stays clean).
export async function buildAndUploadErrorExcel(
  options: BuildErrorExcelOptions,
): Promise<string | null> {
  if (options.errors.length === 0) return null;

  const errorRows = buildErrorRows(options.allRawRows, options.errors);

  if (errorRows.length === 0) return null;

  const buffer = buildXlsxBuffer([
    {
      name: "Failed Rows",
      rows: errorRows,
      // "Errors" column needs more width to fit concatenated messages
      columnWidths: { Errors: 60 },
    },
  ]);

  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `lead-import-errors-${options.epcId.slice(0, 8)}-${timestamp}.xlsx`;
  const s3Key = `imports/errors/${options.logId}/${filename}`;

  await uploadBufferToS3(s3Key, buffer, filename);

  return s3Key;
}

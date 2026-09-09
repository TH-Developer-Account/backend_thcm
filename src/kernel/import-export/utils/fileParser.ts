import Papa from "papaparse";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// fileParser.ts — pure file → Row[] conversion, no side effects
//
// WHY this exists as a separate util:
//   Both the import service (lead import) and potentially future importers
//   need to parse files. Keeping parsing pure and format-agnostic means
//   the service layer only deals with validated row objects, not file buffers.
//
// Supports: .csv, .xlsx, .xls
// Returns:  Row[] where each Row is Record<string, string> with normalised keys
//           (lowercased, trimmed) so callers don't need to worry about
//           "Name" vs "name" vs " name " from user-supplied files.
// ─────────────────────────────────────────────────────────────────────────────

export type RawRow = Record<string, string>;

export type ParseResult = {
  rows: RawRow[];
  totalRows: number;
};

// ── Normalise header keys from user-supplied files ────────────────────────────
// Trims whitespace and lowercases so callers use consistent keys.
function normaliseRow(row: Record<string, unknown>): RawRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.trim().toLowerCase(),
      String(value ?? "").trim(),
    ]),
  );
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(buffer: Buffer): ParseResult {
  const content = buffer.toString("utf-8");

  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (result.errors.length > 0) {
    const firstError = result.errors[0];
    throw new Error(
      `CSV parse error at row ${firstError.row}: ${firstError.message}`,
    );
  }

  const rows = result.data.map(normaliseRow);

  return { rows, totalRows: rows.length };
}

// ── XLSX / XLS parser ─────────────────────────────────────────────────────────
// Always reads the first sheet. Multi-sheet imports are out of scope —
// the convention is one data sheet per import file.
function parseXlsx(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("XLSX file contains no sheets");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "", // empty cells → empty string, not undefined
    raw: false, // format dates as strings, not serial numbers
  });

  const rows = rawRows.map(normaliseRow);

  return { rows, totalRows: rows.length };
}

// ── Public API ────────────────────────────────────────────────────────────────

export type SupportedMimeType =
  | "text/csv"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.ms-excel";

export const SUPPORTED_MIME_TYPES = new Set<string>([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export function isSupportedMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(mimeType);
}

export function parseFile(buffer: Buffer, mimeType: string): ParseResult {
  if (!isSupportedMimeType(mimeType)) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Supported types: CSV, XLSX, XLS`,
    );
  }

  if (mimeType === "text/csv") {
    return parseCsv(buffer);
  }

  return parseXlsx(buffer);
}

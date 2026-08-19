import * as XLSX from "xlsx";
import Papa from "papaparse";

export type RawRow = Record<string, string>;

export type ParseResult = {
  rows: RawRow[];
  totalRows: number;
};

export const SUPPORTED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export const isSupportedMimeType = (mimeType: string): boolean => {
  return SUPPORTED_MIME_TYPES.has(mimeType);
};

// Collapses all whitespace (including embedded newlines from multi-line
// header cells like "Start \n(hh:mm:ss)") to a single space, then
// lowercases and trims.
function normaliseRow(row: Record<string, unknown>): RawRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.trim().toLowerCase().replace(/\s+/g, " "),
      String(value ?? "").trim(),
    ]),
  );
}

function parseCsv(buffer: Buffer): ParseResult {
  const text = buffer.toString("utf-8");
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const rows = parsed.data.map(normaliseRow);
  return { rows, totalRows: rows.length };
}

function parseXlsx(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("XLSX file contains no sheets");

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const rows = rawRows.map(normaliseRow);
  return { rows, totalRows: rows.length };
}

export function parseFile(buffer: Buffer, mimeType: string): ParseResult {
  if (!isSupportedMimeType(mimeType)) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Supported types: CSV, XLSX, XLS`,
    );
  }
  if (mimeType === "text/csv") return parseCsv(buffer);
  return parseXlsx(buffer);
}

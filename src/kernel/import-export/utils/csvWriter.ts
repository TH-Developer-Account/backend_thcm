import Papa from "papaparse";

// ─────────────────────────────────────────────────────────────────────────────
// csvWriter.ts — pure Row[] → CSV Buffer, no side effects
//
// WHY pure: the caller (export service) decides where the buffer goes —
// S3, HTTP response, disk. The writer has no opinion on that.
// ─────────────────────────────────────────────────────────────────────────────

export type CsvRow = Record<string, string | number | boolean | null>;

export function rowsToCsvBuffer(rows: CsvRow[]): Buffer {
  if (rows.length === 0) {
    return Buffer.from("", "utf-8");
  }

  const csv = Papa.unparse(rows, {
    header: true,
    newline: "\r\n", // RFC 4180 compliant
  });

  return Buffer.from(csv, "utf-8");
}

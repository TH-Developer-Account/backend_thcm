import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// xlsxWriter.ts — config-driven multi-sheet XLSX → Buffer, no side effects
//
// WHY config-driven:
//   The EPC dump sheet layout will change as requirements evolve.
//   Instead of hardcoding sheet logic, callers pass a SheetDefinition[]
//   which describes each sheet declaratively. Adding a new sheet or
//   reordering sheets is a config change in the service layer, not here.
//
// Usage:
//   const buffer = buildXlsxBuffer([
//     { name: "EPCs",      rows: epcRows },
//     { name: "LineItems", rows: lineItemRows },
//     { name: "Workflows", rows: workflowRows },
//   ]);
// ─────────────────────────────────────────────────────────────────────────────

export type XlsxRow = Record<string, string | number | boolean | null | Date>;

export type SheetDefinition = {
  // Tab name in the XLSX file
  name: string;
  // Row data — all rows in this sheet
  rows: XlsxRow[];
  // Optional column width hints (characters). Key = column header.
  // If omitted, auto-width is used.
  columnWidths?: Record<string, number>;
};

// ── Auto-calculate column widths from data if not provided ────────────────────
// Looks at header length and first 100 rows to estimate a reasonable width.
function resolveColumnWidths(
  headers: string[],
  rows: XlsxRow[],
  hints: Record<string, number> = {},
): XLSX.ColInfo[] {
  return headers.map((header) => {
    if (hints[header]) {
      return { wch: hints[header] };
    }

    const sampleRows = rows.slice(0, 100);
    const maxDataLength = sampleRows.reduce((max, row) => {
      const cellValue = String(row[header] ?? "");
      return Math.max(max, cellValue.length);
    }, header.length);

    // Cap between 10 and 50 characters
    return { wch: Math.min(Math.max(maxDataLength + 2, 10), 50) };
  });
}

// ── Build a single worksheet from a SheetDefinition ──────────────────────────
function buildWorksheet(definition: SheetDefinition): XLSX.WorkSheet {
  if (definition.rows.length === 0) {
    // Return an empty sheet with a placeholder row so the tab is visible
    return XLSX.utils.aoa_to_sheet([["No data available"]]);
  }

  const worksheet = XLSX.utils.json_to_sheet(definition.rows);

  const headers = Object.keys(definition.rows[0]);
  worksheet["!cols"] = resolveColumnWidths(
    headers,
    definition.rows,
    definition.columnWidths,
  );

  return worksheet;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildXlsxBuffer(sheets: SheetDefinition[]): Buffer {
  if (sheets.length === 0) {
    throw new Error("At least one sheet definition is required");
  }

  const workbook = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const worksheet = buildWorksheet(sheet);
    // XLSX sheet names are limited to 31 characters
    const safeName = sheet.name.slice(0, 31);
    XLSX.utils.book_append_sheet(workbook, worksheet, safeName);
  }

  const xlsxBuffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  });

  return Buffer.from(xlsxBuffer);
}

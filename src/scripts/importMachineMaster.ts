/**
 * scripts/import-machine-master.ts
 *
 *
 * Usage:
 *   npx ts-node scripts/import-machine-master.ts <path-to-Machine_List.xlsx> [--dry-run]
 *
 * --dry-run runs the full parse/normalize pass, resolves customer codes
 * against the DB (read-only), and writes the same "codes not found" report,
 * without writing any Machine rows.
 */

import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";

// ── Config ──────────────────────────────────────────────────────────────────

const PLACEHOLDER_CODES = new Set(["#N/A", "N/A", "NA"]);

// ── Types ───────────────────────────────────────────────────────────────────

// Keys match each sheet's header row exactly - identical across all six sheets.
type RawMachineRow = {
  Status: unknown;
  "Model name": unknown;
  "PIN No.": unknown;
  "Customer name": unknown;
  "Site Location": unknown;
  "Estimated Latest HMR": unknown;
  "Delivery date(yyyy/mm/dd)": unknown;
  "Cust code": unknown;
};

type NormalizedMachine = {
  machineSerialNumber: string;
  modelName: string | null;
  siteLocation: string | null;
  custCode: string | null;
};

type SkippedRow = {
  sheetName: string;
  rowNumber: number; // 1-based, header-exclusive, within its own sheet
  reason: string;
};

type NormalizeResult =
  | { ok: true; value: NormalizedMachine }
  | { ok: false; skipped: SkippedRow };

type ImportSummary = {
  totalRows: number;
  upserted: number;
  skippedInvalid: number;
  distinctCustCodesSeen: number;
  distinctCustCodesNotFound: number;
};

// ── Pure helpers ────────────────────────────────────────────────────────────

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function normalizeCustCode(raw: string | null): string | null {
  if (!raw) return null;
  return PLACEHOLDER_CODES.has(raw.toUpperCase()) ? null : raw;
}

/**
 * Transforms one raw sheet row into a Machine upsert payload, or a skip
 * reason. Pure - no I/O, no DB.
 */
function normalizeMachineRow(
  raw: RawMachineRow,
  sheetName: string,
  rowNumber: number,
): NormalizeResult {
  const machineSerialNumber = cellToString(raw["PIN No."]);

  if (!machineSerialNumber) {
    return {
      ok: false,
      skipped: { sheetName, rowNumber, reason: "missing PIN No." },
    };
  }

  return {
    ok: true,
    value: {
      machineSerialNumber,
      modelName: cellToString(raw["Model name"]),
      siteLocation: cellToString(raw["Site Location"]),
      custCode: normalizeCustCode(cellToString(raw["Cust code"])),
    },
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseMachineSheets(
  filePath: string,
): { sheetName: string; raw: RawMachineRow }[] {
  const workbook = XLSX.readFile(filePath);
  const rows: { sheetName: string; raw: RawMachineRow }[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json<RawMachineRow>(sheet, {
      defval: "",
    });
    sheetRows.forEach((raw) => rows.push({ sheetName, raw }));
  }

  return rows;
}

// ── Normalization pass ───────────────────────────────────────────────────────

function buildNormalizedRows(filePath: string): {
  machines: NormalizedMachine[];
  skipped: SkippedRow[];
} {
  const rows = parseMachineSheets(filePath);
  const machines: NormalizedMachine[] = [];
  const skipped: SkippedRow[] = [];

  // Per-sheet row numbers (1-based, header-exclusive) for a readable report.
  const rowNumberBySheet = new Map<string, number>();

  for (const { sheetName, raw } of rows) {
    const rowNumber = (rowNumberBySheet.get(sheetName) ?? 0) + 1;
    rowNumberBySheet.set(sheetName, rowNumber);

    const result = normalizeMachineRow(raw, sheetName, rowNumber);
    // `=== false`, not `!result.ok` - this repo's non-strict tsconfig fails
    // to narrow a discriminated union through a negated boolean literal
    // (hit this exact issue in the BusinessPartner import script).
    if (result.ok === false) {
      skipped.push(result.skipped);
      continue;
    }
    machines.push(result.value);
  }

  return { machines, skipped };
}

// ── Customer-code resolution ─────────────────────────────────────────────────

/**
 * One query for every distinct customer code in the sheet, instead of one
 * query per row (471 rows but only 153 distinct codes in the current file).
 */
async function resolveCustomerIds(
  custCodes: string[],
): Promise<Map<string, string>> {
  const distinctCodes = [...new Set(custCodes)];
  if (distinctCodes.length === 0) return new Map();

  const matches = await prisma.businessPartner.findMany({
    where: { s4Id: { in: distinctCodes } },
    select: { id: true, s4Id: true },
  });

  const map = new Map<string, string>();
  for (const match of matches) {
    if (match.s4Id) map.set(match.s4Id, match.id);
  }
  return map;
}

// ── Reporting ───────────────────────────────────────────────────────────────

function writeSkipReport(skipped: SkippedRow[], outputPath: string): void {
  const header = "sheetName,rowNumber,reason";
  const lines = skipped.map(
    (row) =>
      `${row.sheetName},${row.rowNumber},"${row.reason.replace(/"/g, '""')}"`,
  );
  fs.writeFileSync(outputPath, [header, ...lines].join("\n"), "utf-8");
}

function writeNotFoundCodesReport(
  notFoundCodes: Map<string, string[]>, // custCode -> affected serial numbers
  outputPath: string,
): void {
  const header = "custCode,affectedMachineSerialNumbers,machineCount";
  const lines = [...notFoundCodes.entries()].map(
    ([code, serials]) => `"${code}","${serials.join(" | ")}",${serials.length}`,
  );
  fs.writeFileSync(outputPath, [header, ...lines].join("\n"), "utf-8");
}

// ── DB write ────────────────────────────────────────────────────────────────

async function upsertMachines(
  machines: NormalizedMachine[],
  customerIdByCode: Map<string, string>,
): Promise<void> {
  // machineSerialNumber is a real @id, so this is a genuine upsert - not the
  // workaround the BusinessPartner import needed for its non-unique s4Id.
  await prisma.$transaction(
    async (tx) => {
      for (const machine of machines) {
        const customerId = machine.custCode
          ? (customerIdByCode.get(machine.custCode) ?? null)
          : null;

        const data = {
          modelName: machine.modelName,
          siteLocation: machine.siteLocation,
          custCode: machine.custCode,
          customerId,
        };

        await tx.machine.upsert({
          where: { machineSerialNumber: machine.machineSerialNumber },
          create: { machineSerialNumber: machine.machineSerialNumber, ...data },
          update: data,
        });
      }
    },
    { timeout: 120_000 },
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , filePathArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");

  if (!filePathArg) {
    console.error(
      "Usage: ts-node scripts/import-machine-master.ts <path-to-Machine_List.xlsx> [--dry-run]",
    );
    process.exit(1);
  }

  const filePath = path.resolve(filePathArg);
  const { machines, skipped } = buildNormalizedRows(filePath);

  const presentCodes = machines
    .map((m) => m.custCode)
    .filter((code): code is string => code !== null);
  const customerIdByCode = await resolveCustomerIds(presentCodes);

  const notFoundCodes = new Map<string, string[]>();
  for (const machine of machines) {
    if (machine.custCode && !customerIdByCode.has(machine.custCode)) {
      const existing = notFoundCodes.get(machine.custCode) ?? [];
      existing.push(machine.machineSerialNumber);
      notFoundCodes.set(machine.custCode, existing);
    }
  }

  const summary: ImportSummary = {
    totalRows: machines.length + skipped.length,
    upserted: machines.length,
    skippedInvalid: skipped.length,
    distinctCustCodesSeen: new Set(presentCodes).size,
    distinctCustCodesNotFound: notFoundCodes.size,
  };

  console.log("Import summary:", summary);

  const outputDir = path.dirname(filePath);

  if (skipped.length > 0) {
    const reportPath = path.resolve(
      outputDir,
      `machine-import-skipped-${Date.now()}.csv`,
    );
    writeSkipReport(skipped, reportPath);
    console.log(`Skipped-row report written to ${reportPath}`);
  }

  if (notFoundCodes.size > 0) {
    const reportPath = path.resolve(
      outputDir,
      `machine-import-customer-codes-not-found-${Date.now()}.csv`,
    );
    writeNotFoundCodesReport(notFoundCodes, reportPath);
    console.log(
      `${notFoundCodes.size} customer code(s) not found in BusinessPartner - report written to ${reportPath}`,
    );
  }

  if (dryRun) {
    console.log("Dry run - no Machine rows were written.");
    return;
  }

  await upsertMachines(machines, customerIdByCode);
  console.log(`Done - upserted ${machines.length} Machine rows.`);
}

main()
  .catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

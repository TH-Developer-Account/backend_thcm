/**
 * scripts/import-machine-master.ts
 *
 * Imports the Tata Hitachi equipment master list ("EQUI_cleaned.xlsx") into
 * the Machine table, and links each machine to its BusinessPartner via the
 * sheet's "Customer" column (matched against BusinessPartner.s4Id, the same
 * field import-business-partners.ts populates).
 *
 * v2 (2026-11-17) - rewritten for "EQUI_cleaned.xlsx", a different (much
 * larger, SAP-native) export than the original "Machine_List.xlsx":
 * - 167,158 rows, one sheet, only three columns: Equipment, ObjectType,
 *   Customer. No Model name/Site Location/Status/warranty/invoice columns
 *   at all this time.
 * - "Equipment" (SAP's internal Equipment Number, e.g. "0139P001644",
 *   "016J-000002") is now machineSerialNumber - confirmed with Fazal this
 *   replaces the old PIN-based serial going forward. This only works if
 *   C4C's daily telemetry sync keys on this same Equipment Number, not the
 *   old PIN - flagged, not independently verified here.
 * - "ObjectType" (e.g. "EX210LCH") -> modelName, the same slot the
 *   original script's "Model name" column filled.
 * - No Site Location data in this file - that column stays null for every
 *   row imported here (it's still on the schema from the first import; it
 *   simply has nothing to populate it with this time).
 * - 159,007 of 167,158 rows (95%) have a Customer code; of the 88,577
 *   distinct codes referenced, 88,575 already exist in
 *   Customer_1_cleaned.xlsx - so BusinessPartner needs to be imported
 *   first, from the same run's companion file, for this link rate to hold.
 * - Plain insert (createMany), not upsert - Fazal is deleting the existing
 *   Machine data before running this, so every row is new. createMany in
 *   batches is also far faster than 167k individual upserts would have
 *   been.
 * - Customer-code resolution is now CHUNKED: 88,577 distinct codes would
 *   blow past Postgres's bound-parameter limit (65535) in a single `IN`
 *   query, so lookups run in batches and merge into one Map.
 *
 * Usage:
 *   npx ts-node scripts/import-machine-master.ts <path-to-EQUI_cleaned.xlsx> [--dry-run]
 *
 * --dry-run runs the full parse/normalize pass, resolves customer codes
 * against the DB (read-only), and writes the same "codes not found"
 * report, without writing any Machine rows.
 */

import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";

// ── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000; // rows per createMany call / per customer-code lookup chunk
const TRANSACTION_TIMEOUT_MS = 300_000; // 167k rows / 1000 ≈ 167 batches - generous headroom

// ── Types ───────────────────────────────────────────────────────────────────

// Keys match the sheet's header row exactly.
type RawMachineRow = {
  Equipment: unknown;
  ObjectType: unknown;
  Customer: unknown;
};

type NormalizedMachine = {
  machineSerialNumber: string;
  modelName: string | null;
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
  imported: number;
  skippedInvalid: number;
  distinctCustCodesSeen: number;
  distinctCustCodesNotFound: number;
};

// ── Pure helpers ────────────────────────────────────────────────────────────

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  // Same "0" convention found (and handled) in the companion customer-master
  // import - kept here for consistency even though this file didn't
  // actually contain any literal-zero junk values when checked.
  if (str.length === 0 || str === "0") return null;
  return str;
}

/**
 * Transforms one raw sheet row into a Machine create payload, or a skip
 * reason. Pure - no I/O, no DB.
 */
function normalizeMachineRow(
  raw: RawMachineRow,
  sheetName: string,
  rowNumber: number,
): NormalizeResult {
  const machineSerialNumber = cellToString(raw["Equipment"]);

  if (!machineSerialNumber) {
    return {
      ok: false,
      skipped: { sheetName, rowNumber, reason: "missing Equipment" },
    };
  }

  return {
    ok: true,
    value: {
      machineSerialNumber,
      modelName: cellToString(raw["ObjectType"]),
      custCode: cellToString(raw["Customer"]),
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
    // to narrow a discriminated union through a negated boolean literal.
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
 * One query per BATCH_SIZE distinct customer codes, instead of one giant
 * query (88,577 distinct codes in the current file would exceed Postgres's
 * 65535 bound-parameter limit in a single `IN (...)`) or one query per row.
 */
async function resolveCustomerIds(
  custCodes: string[],
): Promise<Map<string, string>> {
  const distinctCodes = [...new Set(custCodes)];
  const map = new Map<string, string>();

  for (let i = 0; i < distinctCodes.length; i += BATCH_SIZE) {
    const chunk = distinctCodes.slice(i, i + BATCH_SIZE);
    const matches = await prisma.businessPartner.findMany({
      where: { s4Id: { in: chunk } },
      select: { id: true, s4Id: true },
    });
    for (const match of matches) {
      if (match.s4Id) map.set(match.s4Id, match.id);
    }
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
  notFoundCodes: Map<string, string[]>, // custCode -> affected machineSerialNumbers
  outputPath: string,
): void {
  const header = "custCode,affectedMachineSerialNumbers,machineCount";
  const lines = [...notFoundCodes.entries()].map(
    ([code, serials]) => `"${code}","${serials.join(" | ")}",${serials.length}`,
  );
  fs.writeFileSync(outputPath, [header, ...lines].join("\n"), "utf-8");
}

// ── DB write ────────────────────────────────────────────────────────────────

async function insertInBatches(
  machines: NormalizedMachine[],
  customerIdByCode: Map<string, string>,
): Promise<void> {
  const payload = machines.map((machine) => ({
    machineSerialNumber: machine.machineSerialNumber,
    modelName: machine.modelName,
    custCode: machine.custCode,
    customerId: machine.custCode
      ? (customerIdByCode.get(machine.custCode) ?? null)
      : null,
  }));

  await prisma.$transaction(
    async (tx) => {
      for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        await tx.machine.createMany({ data: payload.slice(i, i + BATCH_SIZE) });
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , filePathArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");

  if (!filePathArg) {
    console.error(
      "Usage: ts-node scripts/import-machine-master.ts <path-to-EQUI_cleaned.xlsx> [--dry-run]",
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
    imported: machines.length,
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

  await insertInBatches(machines, customerIdByCode);
  console.log(`Done - inserted ${machines.length} Machine rows.`);
}

main()
  .catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

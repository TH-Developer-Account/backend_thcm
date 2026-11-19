// modules/machine-telemetry/scripts/importMachines.ts
//
// One-time import: reads "Sheet1" of the given Excel workbook (column
// "Machine Serial No.") and upserts each serial number into Machine.
// customerId is intentionally left untouched here — it's out of scope for
// this script, and is never populated from C4C either (see the daily sync
// service) — filled by a separate process later, per the agreed design.
//
// Run once, manually, from the repo root:
//   npx ts-node -r tsconfig-paths/register modules/machine-telemetry/scripts/importMachines.ts src/scripts/data/machine_serial_no.xlsx
//
// Safe to re-run: skipDuplicates means re-running against the same file,
// or a file with overlapping serials, never errors or creates duplicates —
// useful if the sheet gets a follow-up batch of new machines later.

import * as XLSX from "xlsx";
import { prisma } from "../shared/config/prisma";

const SHEET_NAME = "Sheet1";
const SERIAL_COLUMN_HEADER = "Machine Serial No.";
const BATCH_SIZE = 500;

type ParsedRow = Record<string, unknown>;

// Pure — no DB, no I/O side effects beyond the file read itself. Kept
// separate from importMachines() so the parsing logic is testable without
// a database connection.
function readSerialNumbersFromWorkbook(filePath: string): string[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(
      `Workbook has no sheet named "${SHEET_NAME}". Found: ${workbook.SheetNames.join(", ")}`,
    );
  }

  const rows = XLSX.utils.sheet_to_json<ParsedRow>(sheet, { defval: "" });

  const serialNumbers = rows
    .map((row) => String(row[SERIAL_COLUMN_HEADER] ?? "").trim())
    .filter((serialNumber) => serialNumber.length > 0);

  const uniqueSerialNumbers = Array.from(new Set(serialNumbers));
  if (uniqueSerialNumbers.length !== serialNumbers.length) {
    console.warn(
      `Found ${serialNumbers.length - uniqueSerialNumbers.length} duplicate serial number(s) in the sheet — deduplicated before import.`,
    );
  }

  return uniqueSerialNumbers;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function importMachines(filePath: string): Promise<void> {
  const serialNumbers = readSerialNumbersFromWorkbook(filePath);
  console.log(
    `Read ${serialNumbers.length} unique serial numbers from ${filePath}`,
  );

  // Batched, not one createMany for all 11,099 — keeps a single statement
  // from holding a large transaction/lock, and keeps memory bounded if this
  // script is ever pointed at a much bigger sheet later.
  let createdCount = 0;
  for (const batch of chunk(serialNumbers, BATCH_SIZE)) {
    const result = await prisma.machine.createMany({
      data: batch.map((serialNumber) => ({
        machineSerialNumber: serialNumber,
      })),
      skipDuplicates: true,
    });
    createdCount += result.count;
  }

  console.log(
    `Import complete: ${createdCount} new machine(s) created, ${serialNumbers.length - createdCount} already existed.`,
  );
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: ts-node importMachines.ts <path-to-xlsx>");
  process.exit(1);
}

importMachines(filePath)
  .catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

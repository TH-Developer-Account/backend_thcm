// scripts/importKeyAccountMachines.ts
//
// One-time (re-runnable) import: reads the "KA Population" sheet of the
// given key-account Excel (column "Equipment" = machine serial number) and
// flags every one of those machines as isKeyAccount: true on Machine,
// creating a bare Machine row for any serial not already present.
//
// Net effect is an upsert, but implemented as two bulk operations instead
// of one upsert per row (15,335 rows in the file this was built against):
//   1. createMany + skipDuplicates — creates a bare row for every serial
//      not yet in Machine, with isKeyAccount already set to true.
//   2. batched updateMany — flags isKeyAccount: true for every serial in
//      the list, including the ones that already existed before step 1
//      (createMany's skipDuplicates means it silently skips those, so
//      without this second pass their flag would never get set).
//
// Scope, per the agreed design: this script ONLY sets isKeyAccount. It
// does not touch custCode/customerId/isConsiteMachine or anything else on
// Machine — run scripts/classifyMachineTelematicsSource.ts separately
// (before or after this script; it's idempotent and classifies every
// machine, so run order between the two doesn't matter) to set
// isConsiteMachine.
//
// Run once, manually, from the repo root:
//   npx ts-node -r tsconfig-paths/register scripts/importKeyAccountMachines.ts \
//     scripts/data/October_2026_Population.xlsx [--dry-run]
//
// Safe to re-run against the same file, or a refreshed one with an
// overlapping/updated serial list — every operation here is idempotent.

import * as path from "path";
import * as XLSX from "xlsx";
import { prisma } from "../shared/config/prisma";

const SHEET_NAME = "KA Population";
const EQUIPMENT_COLUMN_HEADER = "Equipment";
const UPDATE_BATCH_SIZE = 2000;

type ParsedRow = Record<string, unknown>;

// Pure — no DB, no I/O side effects beyond the file read itself.
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
    .map((row) => String(row[EQUIPMENT_COLUMN_HEADER] ?? "").trim())
    .filter((serialNumber) => serialNumber.length > 0);

  const uniqueSerialNumbers = Array.from(new Set(serialNumbers));
  if (uniqueSerialNumbers.length !== serialNumbers.length) {
    console.warn(
      `Found ${serialNumbers.length - uniqueSerialNumbers.length} duplicate Equipment value(s) in the sheet — deduplicated before import.`,
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

async function importKeyAccountMachines(
  filePath: string,
  dryRun: boolean,
): Promise<void> {
  const serialNumbers = readSerialNumbersFromWorkbook(filePath);
  console.log(
    `Read ${serialNumbers.length} unique key-account Equipment value(s) from ${filePath}`,
  );

  const existing = await prisma.machine.findMany({
    where: { machineSerialNumber: { in: serialNumbers } },
    select: { machineSerialNumber: true, isKeyAccount: true },
  });
  const existingSet = new Set(existing.map((m) => m.machineSerialNumber));
  const alreadyFlagged = existing.filter((m) => m.isKeyAccount).length;

  const missing = serialNumbers.filter(
    (serialNumber) => !existingSet.has(serialNumber),
  );

  console.log(
    `${existing.length} already exist in Machine (${alreadyFlagged} already flagged isKeyAccount), ${missing.length} will be created.`,
  );

  if (dryRun) {
    console.log("Dry run — no Machine rows were written.");
    return;
  }

  // Step 1 — create any missing machines, already flagged.
  if (missing.length > 0) {
    const created = await prisma.machine.createMany({
      data: missing.map((machineSerialNumber) => ({
        machineSerialNumber,
        isKeyAccount: true,
      })),
      skipDuplicates: true,
    });
    console.log(`Created ${created.count} new Machine row(s).`);
  }

  // Step 2 — flag every serial in the list, including ones that already
  // existed before step 1 (createMany's skipDuplicates never updates them).
  let flaggedCount = 0;
  for (const batch of chunk(serialNumbers, UPDATE_BATCH_SIZE)) {
    const result = await prisma.machine.updateMany({
      where: { machineSerialNumber: { in: batch } },
      data: { isKeyAccount: true },
    });
    flaggedCount += result.count;
  }

  console.log(
    `Import complete: ${missing.length} machine(s) created, ${flaggedCount} machine(s) flagged isKeyAccount: true.`,
  );
}

const [, , filePathArg, ...flags] = process.argv;
const dryRun = flags.includes("--dry-run");

if (!filePathArg) {
  console.error(
    "Usage: ts-node scripts/importKeyAccountMachines.ts <path-to-KA-population.xlsx> [--dry-run]",
  );
  process.exit(1);
}

importKeyAccountMachines(path.resolve(filePathArg), dryRun)
  .catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

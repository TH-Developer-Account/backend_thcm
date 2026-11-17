/**
 * scripts/import-business-partners.ts
 *
 * One-off bulk import of the Tata Hitachi customer master export
 * ("Customer.xlsx") into BusinessPartner + BusinessPartnerAddress.
 *
 * Decisions this script bakes in (confirmed with Fazal, 2026-11-12):
 * - "Customer" (the SAP customer code) -> BusinessPartner.s4Id. s4Id has no
 *   unique constraint yet, so this is a plain insert, not an upsert.
 * - bpType = "CUSTOMER" and officeType = "HEAD_OFFICE" for every row - the
 *   sheet carries nothing that would let us tell these apart per row.
 * - No upsert, by design: existing BusinessPartner rows are not touched,
 *   and re-running this script will create duplicates. Fazal is handling
 *   data cleanup (including an eventual s4Id unique constraint) separately.
 * - Rows sharing the same "Customer" code are the same master record
 *   re-exported (confirmed: usually differing only by email) - only the
 *   FIRST occurrence of each code is imported; later ones are skipped and
 *   logged to the report CSV, never silently dropped.
 * - GST No. placeholder value "888888888888888" (seen on ~1,700 rows) is
 *   treated as not-provided (null), not stored as literal junk.
 * - "Rg" (state/region) is stored as-is: 2-letter SAP codes (e.g. "KA") are
 *   translated to full state names, matching how BusinessPartnerAddress.state
 *   is persisted everywhere else in this app (see utils/indianStates.ts).
 *   Bare numeric SAP region codes (e.g. "10", "20") have no known mapping on
 *   our side and are left as the raw numeric string, for manual cleanup later.
 * - "Fax Number" is dropped - BusinessPartnerAddress has no fax field.
 *
 * Usage:
 *   npx ts-node scripts/import-business-partners.ts <path-to-Customer.xlsx> [--dry-run]
 *
 * --dry-run runs the full parse/validate pass and writes the same skip
 * report, without writing anything to the database.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";
// Adjust this relative path if your generated client lives somewhere else -
// this matches the depth used in kernel/business-partner/businessPartner.services.ts,
// one level up from scripts/ instead of two.
import {
  BusinessPartnerOfficeType,
  Prisma,
} from "../prisma/generated/prisma/client";

// ── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000; // rows per createMany call - keeps us well under Postgres's bound-parameter limit

// bpType is a plain string field in the schema (not a Prisma enum) - this
// mirrors the value admin/business-partners/utils/bp.types.ts's
// BUSINESS_PARTNER_TYPE_OPTIONS uses for "Customer".
const IMPORTED_BP_TYPE = "CUSTOMER";

const GST_PLACEHOLDER = "888888888888888";

// SAP's 2-letter state codes seen in this sheet -> full name, matching how
// BusinessPartnerAddress.state is persisted elsewhere (utils/indianStates.ts).
// Bare numeric codes (e.g. "10", "20") have no known mapping and are passed
// through as-is, per the 2026-11-12 decision to clean those up manually later.
const STATE_CODE_TO_NAME: Record<string, string> = {
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CG: "Chhattisgarh",
  GA: "Goa",
  GJ: "Gujarat",
  HR: "Haryana",
  HP: "Himachal Pradesh",
  JH: "Jharkhand",
  KA: "Karnataka",
  KL: "Kerala",
  MP: "Madhya Pradesh",
  MH: "Maharashtra",
  MN: "Manipur",
  ML: "Meghalaya",
  MZ: "Mizoram",
  NL: "Nagaland",
  OR: "Odisha",
  PB: "Punjab",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TG: "Telangana",
  TR: "Tripura",
  UP: "Uttar Pradesh",
  UA: "Uttarakhand",
  WB: "West Bengal",
  AN: "Andaman and Nicobar Islands",
  CH: "Chandigarh",
  DN: "Dadra and Nagar Haveli and Daman and Diu",
  DD: "Dadra and Nagar Haveli and Daman and Diu",
  DL: "Delhi",
  JK: "Jammu and Kashmir",
  LA: "Ladakh",
  LD: "Lakshadweep",
  PY: "Puducherry",
};

// ── Types ───────────────────────────────────────────────────────────────────

// Keys match the sheet's header row exactly.
type RawCustomerRow = {
  Customer: unknown;
  "Customer Name": unknown;
  "Name 2": unknown;
  Rg: unknown;
  "Country/Region Key": unknown;
  PostalCode: unknown;
  "GST No.": unknown;
  "PAN No.": unknown;
  "Telephone 1": unknown;
  "Fax Number": unknown;
  "E-Mail Address": unknown;
};

type NormalizedPartner = {
  businessPartner: Prisma.BusinessPartnerCreateManyInput;
  address: Prisma.BusinessPartnerAddressCreateManyInput;
};

type SkippedRow = {
  rowNumber: number; // 1-based, matches the row number you'd see in Excel (header = row 1)
  customerCode: string;
  reason: string;
};

type NormalizeResult =
  | { ok: true; value: NormalizedPartner }
  | { ok: false; skipped: SkippedRow };

type ImportSummary = {
  totalRows: number;
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
};

// ── Pure helpers ────────────────────────────────────────────────────────────
// Everything below this point up to buildBatches() is deliberately pure -
// no I/O, no DB, no Date.now()/randomness - so the mapping rules can be
// read (and unit-tested) independently of how rows are read or written.

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function normalizeGst(raw: string | null): string | null {
  if (!raw) return null;
  return raw === GST_PLACEHOLDER ? null : raw;
}

function normalizeState(rawRg: string | null): string | null {
  if (!rawRg) return null;
  return STATE_CODE_TO_NAME[rawRg.toUpperCase()] ?? rawRg;
}

/**
 * Transforms one raw sheet row into a BusinessPartner + BusinessPartnerAddress
 * pair, or a skip reason. The caller supplies the id so this stays pure.
 */
function normalizeCustomerRow(
  raw: RawCustomerRow,
  rowNumber: number,
  businessPartnerId: string,
): NormalizeResult {
  const customerCode = cellToString(raw["Customer"]);
  const bpName = cellToString(raw["Customer Name"]);

  if (!customerCode) {
    return {
      ok: false,
      skipped: { rowNumber, customerCode: "", reason: "missing Customer code" },
    };
  }

  if (!bpName) {
    return {
      ok: false,
      skipped: { rowNumber, customerCode, reason: "missing Customer Name" },
    };
  }

  // SAP's two-line name field: "Customer Name" + "Name 2" together often make
  // up the full legal name (e.g. "TATA HITACHI CONSTRUCTION MACHINERY" +
  // "COMPANY PRIVATE LIMITED"). This is an assumption, not confirmed with
  // Fazal - worth revisiting if "Name 2" turns out to mean something else
  // for some rows (a c/o line, a trading name, etc).
  const nameContinuation = cellToString(raw["Name 2"]);

  const businessPartner: Prisma.BusinessPartnerCreateManyInput = {
    id: businessPartnerId,
    s4Id: customerCode,
    bpName,
    legalTradeName: nameContinuation ? `${bpName} ${nameContinuation}` : null,
    gst: normalizeGst(cellToString(raw["GST No."])),
    panNumber: cellToString(raw["PAN No."]),
    officeType: BusinessPartnerOfficeType.HEAD_OFFICE,
    bpType: IMPORTED_BP_TYPE,
  };

  const address: Prisma.BusinessPartnerAddressCreateManyInput = {
    businessPartnerId,
    state: normalizeState(cellToString(raw["Rg"])),
    country: cellToString(raw["Country/Region Key"]),
    pincode: cellToString(raw["PostalCode"]),
    phoneNo: cellToString(raw["Telephone 1"]),
    email: cellToString(raw["E-Mail Address"]),
    isDefault: true,
  };

  return { ok: true, value: { businessPartner, address } };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseCustomerSheet(filePath: string): RawCustomerRow[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<RawCustomerRow>(sheet, { defval: "" });
}

// ── Batch building ──────────────────────────────────────────────────────────

function buildBatches(filePath: string): {
  partners: Prisma.BusinessPartnerCreateManyInput[];
  addresses: Prisma.BusinessPartnerAddressCreateManyInput[];
  skipped: SkippedRow[];
} {
  const rows = parseCustomerSheet(filePath);
  const seenCodes = new Set<string>();

  const partners: Prisma.BusinessPartnerCreateManyInput[] = [];
  const addresses: Prisma.BusinessPartnerAddressCreateManyInput[] = [];
  const skipped: SkippedRow[] = [];

  rows.forEach((raw, index) => {
    const rowNumber = index + 2; // header occupies row 1 in the spreadsheet
    const customerCode = cellToString(raw["Customer"]) ?? "";

    if (customerCode && seenCodes.has(customerCode)) {
      skipped.push({
        rowNumber,
        customerCode,
        reason: "duplicate Customer code - keeping first occurrence only",
      });
      return;
    }

    const businessPartnerId = crypto.randomUUID();
    const result = normalizeCustomerRow(raw, rowNumber, businessPartnerId);

    // Written as `=== false` rather than `!result.ok`: under this repo's
    // non-strict tsconfig, TS fails to narrow the discriminated union through
    // a negated boolean literal, only through an explicit equality check.
    if (result.ok === false) {
      skipped.push(result.skipped);
      return;
    }

    seenCodes.add(customerCode);
    partners.push(result.value.businessPartner);
    addresses.push(result.value.address);
  });

  return { partners, addresses, skipped };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function writeSkipReport(skipped: SkippedRow[], outputPath: string): void {
  const header = "rowNumber,customerCode,reason";
  const lines = skipped.map(
    (row) =>
      `${row.rowNumber},"${row.customerCode}","${row.reason.replace(/"/g, '""')}"`,
  );
  fs.writeFileSync(outputPath, [header, ...lines].join("\n"), "utf-8");
}

// ── DB write ────────────────────────────────────────────────────────────────

async function insertInBatches(
  partners: Prisma.BusinessPartnerCreateManyInput[],
  addresses: Prisma.BusinessPartnerAddressCreateManyInput[],
): Promise<void> {
  // One transaction around every chunk: either the whole import lands, or
  // none of it does. No half-loaded state if a later chunk fails.
  // Explicit timeout: ~50 batched queries at this row count will comfortably
  // exceed Prisma's 5s interactive-transaction default.
  await prisma.$transaction(
    async (tx) => {
      for (let i = 0; i < partners.length; i += BATCH_SIZE) {
        await tx.businessPartner.createMany({
          data: partners.slice(i, i + BATCH_SIZE),
        });
      }
      for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        await tx.businessPartnerAddress.createMany({
          data: addresses.slice(i, i + BATCH_SIZE),
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
      "Usage: ts-node scripts/import-business-partners.ts <path-to-Customer.xlsx> [--dry-run]",
    );
    process.exit(1);
  }

  const filePath = path.resolve(filePathArg);
  const { partners, addresses, skipped } = buildBatches(filePath);

  const summary: ImportSummary = {
    totalRows: partners.length + skipped.length,
    imported: partners.length,
    skippedDuplicates: skipped.filter((row) =>
      row.reason.startsWith("duplicate"),
    ).length,
    skippedInvalid: skipped.filter((row) => !row.reason.startsWith("duplicate"))
      .length,
  };

  console.log("Import summary:", summary);

  if (skipped.length > 0) {
    const reportPath = path.resolve(
      path.dirname(filePath),
      `business-partner-import-skipped-${Date.now()}.csv`,
    );
    writeSkipReport(skipped, reportPath);
    console.log(`Skipped-row report written to ${reportPath}`);
  }

  if (dryRun) {
    console.log("Dry run - nothing was written to the database.");
    return;
  }

  await insertInBatches(partners, addresses);
  console.log(
    `Done - inserted ${partners.length} BusinessPartner rows (+ addresses).`,
  );
}

main()
  .catch((error) => {
    console.error("Import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * scripts/import-business-partners.ts
 *
 * Bulk import of the Tata Hitachi customer master export into
 * BusinessPartner + BusinessPartnerAddress.
 *
 * v2 (2026-11-17) - rewritten for "Customer_1_cleaned.xlsx", a different
 * (larger, cleaner) export than the original "Customer.xlsx":
 * - 151,211 rows, all unique Customer codes (no in-sheet duplicates this
 *   time - the dedupe-by-code guard is kept anyway as a safety net, in case
 *   a future export isn't as clean).
 * - Column set changed completely: no "Name 2" (so legalTradeName has no
 *   source anymore - always null), no email column, but NEW columns this
 *   version can use: City and Street (real address text).
 * - "Address" column (a plain incrementing integer, e.g. 46511, 46514,
 *   46517...) is an internal SAP address-reference number, not real
 *   address text - confirmed with Fazal, dropped entirely. Street is the
 *   real address line.
 * - GST cleanup is now a real GSTIN format check (regex), not a single
 *   placeholder literal - this export has many junk patterns in that
 *   column ("NA", "99999", ".", raw phone numbers, etc.), not just one.
 * - Plain insert (createMany), no upsert - Fazal is deleting the existing
 *   BusinessPartner data before running this, so every row is new.
 * - bpType = "CUSTOMER", officeType = "HEAD_OFFICE" for every row, same
 *   call as the original import (no column in any version of this sheet
 *   tells these apart).
 * - Rows sharing the same Customer code (if any ever appear) - only the
 *   FIRST occurrence is imported; the rest are skipped and logged, same as
 *   before.
 *
 * Usage:
 *   npx ts-node scripts/import-business-partners.ts <path-to-Customer_1_cleaned.xlsx> [--dry-run]
 *
 * --dry-run runs the full parse/validate pass and writes the same skip
 * report, without touching the database.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";
// Adjust this relative path if your generated client lives somewhere else.
import {
  BusinessPartnerOfficeType,
  Prisma,
} from "../prisma/generated/prisma/client";

// ── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000; // rows per createMany call
const TRANSACTION_TIMEOUT_MS = 300_000; // 151k rows / 1000 ≈ 150 batches per table - generous headroom

// bpType is a plain string field in the schema (not a Prisma enum) - this
// mirrors the value admin/business-partners/utils/bp.types.ts's
// BUSINESS_PARTNER_TYPE_OPTIONS uses for "Customer".
const IMPORTED_BP_TYPE = "CUSTOMER";

// Standard GSTIN shape: 2-digit state code + 10-char PAN + entity code +
// "Z" + checksum char. Anything that doesn't match this is treated as
// junk/not-provided (this export has many different junk patterns: "NA",
// "99999", ".", GST-shaped-but-wrong strings, raw phone numbers, etc. - a
// single placeholder-literal check like the original script used isn't
// enough here).
const GST_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// SAP's 2-letter state codes seen in this sheet -> full name, matching how
// BusinessPartnerAddress.state is persisted elsewhere (utils/indianStates.ts).
// Bare numeric codes and codes for non-Indian regions have no known mapping
// and are passed through as-is.
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
  "Ctry/Reg.": unknown;
  "Name 1": unknown;
  City: unknown;
  "Post.Code": unknown;
  Rg: unknown;
  Street: unknown;
  Telephone1: unknown;
  Address: unknown; // SAP's internal address-reference number - read but never used (see header comment)
  "PAN No": unknown;
  "GST No": unknown;
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
// Everything up to buildBatches() is deliberately pure - no I/O, no DB, no
// Date.now()/randomness - so the mapping rules can be read (and
// unit-tested) independently of how rows are read or written.

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  // This export uses a literal "0" in several text columns (Name 1, City,
  // Street) to mean "no value", not an empty cell - confirmed against real
  // rows (e.g. customer 86498 has Name 1 = 0, City = 0, Street = 0, but a
  // real postcode/phone/GST). No genuine name, city, or street is ever
  // just "0", so this is never mistaken for real data.
  if (str.length === 0 || str === "0") return null;
  return str;
}

function normalizeGst(raw: string | null): string | null {
  if (!raw) return null;
  return GST_FORMAT.test(raw.toUpperCase()) ? raw : null;
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
  const bpName = cellToString(raw["Name 1"]);

  if (!customerCode) {
    return {
      ok: false,
      skipped: { rowNumber, customerCode: "", reason: "missing Customer code" },
    };
  }

  if (!bpName) {
    return {
      ok: false,
      skipped: { rowNumber, customerCode, reason: "missing Name 1" },
    };
  }

  const businessPartner: Prisma.BusinessPartnerCreateManyInput = {
    id: businessPartnerId,
    s4Id: customerCode,
    bpName,
    legalTradeName: null, // no "Name 2" column in this export - nothing to derive it from
    gst: normalizeGst(cellToString(raw["GST No"])),
    panNumber: cellToString(raw["PAN No"]),
    officeType: BusinessPartnerOfficeType.HEAD_OFFICE,
    bpType: IMPORTED_BP_TYPE,
  };

  const address: Prisma.BusinessPartnerAddressCreateManyInput = {
    businessPartnerId,
    state: normalizeState(cellToString(raw["Rg"])),
    country: cellToString(raw["Ctry/Reg."]),
    city: cellToString(raw["City"]),
    pincode: cellToString(raw["Post.Code"]),
    address: cellToString(raw["Street"]),
    phoneNo: cellToString(raw["Telephone1"]),
    email: null, // no email column in this export
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

    // `=== false`, not `!result.ok` - this repo's non-strict tsconfig fails
    // to narrow a discriminated union through a negated boolean literal.
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
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , filePathArg, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");

  if (!filePathArg) {
    console.error(
      "Usage: ts-node scripts/import-business-partners.ts <path-to-Customer_1_cleaned.xlsx> [--dry-run]",
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

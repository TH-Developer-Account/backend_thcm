/**
 * One-off data-migration script: loads Dealership_Branches.xlsx and Active_Dealer.xlsx
 * into the BusinessPartner / BusinessPartnerAddress / BusinessPartnerContact tables.
 *
 * Run manually: npx ts-node scripts/importBusinessPartners.ts
 * Safe to re-run: all writes are upserts keyed on internalId.
 */
import * as XLSX from "xlsx";
import { prisma } from "../shared/config/prisma"; // adjust path to match your project layout
import { BusinessPartnerOfficeType } from "../prisma/generated/prisma/client";

const DEALERSHIP_BRANCHES_FILE = "./src/scripts/data/Dealership_Branches.xlsx";
const ACTIVE_DEALER_FILE = "./src/scripts/data/Active_Dealer.xlsx";

// ─────────────────────────────────────────────
// Row shapes (only the columns we actually use)
// ─────────────────────────────────────────────

interface BranchRow {
  location: string;
  code: string;
  region: string;
  dealerShortName: string;
  facility: "HO" | "Branch" | "Workshop" | "Not assigned";
  status: string;
}

interface ActiveDealerRow {
  dealershipShortName: string;
  fullNameOfDealership: string;
  vendorCode: string;
  dpName: string;
  dpEmail: string;
  dpMobile: string;
  gmCeoName: string;
  gstNo: string;
  panNo: string;
  typeOfCompany: string;
  address: string;
  dateOfCob: string | number | undefined;
  websiteMailId: string;
}

/**
 * Excel cells can come back as numbers even for "text" fields (phone numbers, codes) depending
 * on how the cell was typed in the sheet. Coerce everything meant to be text-ish to a string so
 * we don't hand Prisma a number where it expects String.
 */
function toStringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

/**
 * Both source sheets have unreliable headers (Dealership_Branches has a blank header cell
 * over the Code column; Active_Dealer repeats "Mobile No." for two different people, which
 * silently collides under a header-keyed parse). Reading by fixed column index sidesteps both.
 */
function parseBranchSheet(sheet: XLSX.WorkSheet): BranchRow[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  return rows.slice(1).map((r) => ({
    location: toStringOrUndefined(r[0]) ?? "",
    code: toStringOrUndefined(r[1]) ?? "",
    region: toStringOrUndefined(r[2]) ?? "",
    dealerShortName: toStringOrUndefined(r[3]) ?? "",
    facility: r[4] as BranchRow["facility"],
    status: toStringOrUndefined(r[9]) ?? "",
  }));
}

function parseActiveDealerSheet(sheet: XLSX.WorkSheet): ActiveDealerRow[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  return rows.slice(1).map((r) => ({
    dealershipShortName: toStringOrUndefined(r[1]) ?? "",
    fullNameOfDealership: toStringOrUndefined(r[3]) ?? "",
    vendorCode: toStringOrUndefined(r[4]) ?? "",
    dpName: toStringOrUndefined(r[6]) ?? "",
    dpEmail: toStringOrUndefined(r[7]) ?? "",
    dpMobile: toStringOrUndefined(r[8]) ?? "",
    gmCeoName: toStringOrUndefined(r[9]) ?? "",
    gstNo: toStringOrUndefined(r[13]) ?? "",
    panNo: toStringOrUndefined(r[14]) ?? "",
    typeOfCompany: toStringOrUndefined(r[15]) ?? "",
    address: toStringOrUndefined(r[16]) ?? "",
    dateOfCob: r[17] as string | number | undefined,
    websiteMailId: toStringOrUndefined(r[12]) ?? "",
  }));
}

// ─────────────────────────────────────────────
// Pure helpers — no I/O, easy to unit test independently
// ─────────────────────────────────────────────

/** Normalizes a dealer/organization name for fuzzy comparison (case, punctuation, whitespace). */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,()]/g, "")
    .replace(/\b(PVT|PRIVATE|LTD|LIMITED|LLP|CORPORATION|CORP)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A branch's Code embeds its parent HO's code, e.g. "W-A64530-11" → "A64530",
 * "S1-P85850-11" → "P85850". Plain codes (no dashes) belong to no parent (they're HO-only rows).
 */
function resolveParentCode(branchCode: string): string | null {
  const parts = branchCode.trim().split("-");
  return parts.length === 3 ? parts[1] : null;
}

/**
 * Finds the matching Active_Dealer row for a given HO's Location/short name.
 * STRICT exact match only (after normalization) — deliberately no substring/fuzzy
 * fallback. A short dealer code (e.g. "S1", "AUTOBAHN-M") can accidentally be a
 * substring of an unrelated dealership's name, which previously caused a wrong
 * row's contact/GST/address data to be written onto the wrong BusinessPartner.
 * A missed match (returns null, logged, fixed manually) is far cheaper than a
 * false match (silently wrong data). Do not reintroduce .includes() here.
 */
function matchActiveDealerRow(
  hoLocationName: string,
  hoShortName: string,
  activeDealerRows: ActiveDealerRow[],
): ActiveDealerRow | null {
  const targetA = normalizeName(hoLocationName);
  const targetB = normalizeName(hoShortName);

  for (const row of activeDealerRows) {
    if (!row.fullNameOfDealership) continue;
    const candidateFull = normalizeName(row.fullNameOfDealership);
    const candidateShort = normalizeName(row.dealershipShortName ?? "");
    const isMatch =
      candidateFull === targetA ||
      candidateShort === targetB ||
      candidateFull === targetB ||
      candidateShort === targetA;
    if (isMatch) return row;
  }
  return null;
}

// ─────────────────────────────────────────────
// Phase 1 — load BusinessPartner rows (HO first, then branches)
// ─────────────────────────────────────────────

async function loadBranchRows(rows: BranchRow[]): Promise<Map<string, string>> {
  const codeToId = new Map<string, string>(); // Dealership_Branches Code → BusinessPartner.id

  const hoRows = rows.filter((r) => r.facility === "HO");
  const branchRows = rows.filter((r) => r.facility !== "HO");

  for (const row of hoRows) {
    if (!row.code) continue; // defensive: skip any row that still has no code after positional parse
    const bp = await prisma.businessPartner.upsert({
      where: { internalId: row.code },
      update: {
        bpName: row.location,
        bpShortName: row.dealerShortName,
        isActive: row.status === "Active",
      },
      create: {
        internalId: row.code,
        bpName: row.location,
        bpShortName: row.dealerShortName,
        officeType: BusinessPartnerOfficeType.HEAD_OFFICE,
        bpType: "DEALER",
        isActive: row.status === "Active",
      },
    });
    codeToId.set(row.code, bp.id);
  }

  const unresolvedParents: string[] = [];

  for (const row of branchRows) {
    if (!row.code) continue;
    const parentCode = resolveParentCode(row.code);
    const parentId = parentCode ? (codeToId.get(parentCode) ?? null) : null;
    if (parentCode && !parentId) unresolvedParents.push(row.code);

    const bp = await prisma.businessPartner.upsert({
      where: { internalId: row.code },
      update: {
        bpName: row.location,
        bpShortName: row.dealerShortName,
        isActive: row.status === "Active",
        parentId,
      },
      create: {
        internalId: row.code,
        bpName: row.location,
        bpShortName: row.dealerShortName,
        officeType: BusinessPartnerOfficeType.BRANCH_OFFICE,
        bpType: "DEALER",
        isActive: row.status === "Active",
        parentId,
      },
    });
    codeToId.set(row.code, bp.id);
  }

  if (unresolvedParents.length > 0) {
    console.warn(
      `⚠ ${unresolvedParents.length} branch rows loaded with parentId = null (no matching HO code found). Needs manual fix:`,
      unresolvedParents,
    );
  }

  return codeToId;
}

// ─────────────────────────────────────────────
// Phase 2 — enrich HO rows with Active_Dealer data (GST, address, contacts)
// ─────────────────────────────────────────────

async function enrichHeadOffices(
  activeDealerRows: ActiveDealerRow[],
): Promise<void> {
  const headOffices = await prisma.businessPartner.findMany({
    where: { officeType: BusinessPartnerOfficeType.HEAD_OFFICE },
  });

  const unmatched: string[] = [];

  for (const ho of headOffices) {
    const match = matchActiveDealerRow(
      ho.bpName,
      ho.bpShortName ?? "",
      activeDealerRows,
    );
    if (!match) {
      unmatched.push(ho.bpName);
      continue;
    }

    await prisma.businessPartner.update({
      where: { id: ho.id },
      data: {
        gst: match.gstNo || undefined,
        panNumber: match.panNo || undefined,
        entityType: match.typeOfCompany || undefined,
        vendorCode: match.vendorCode || undefined,
        joinedOn: match.dateOfCob ? new Date(match.dateOfCob) : undefined,
      },
    });

    // No composite unique constraint exists for (businessPartnerId, isDefault) or
    // (businessPartnerId, email) — find-then-write instead of upsert() to stay correct.
    if (match.address) {
      const existingAddress = await prisma.businessPartnerAddress.findFirst({
        where: { businessPartnerId: ho.id, isDefault: true },
      });
      const addressData = {
        address: match.address,
        website: match.websiteMailId || undefined,
      };
      if (existingAddress) {
        await prisma.businessPartnerAddress.update({
          where: { id: existingAddress.id },
          data: addressData,
        });
      } else {
        await prisma.businessPartnerAddress.create({
          data: { businessPartnerId: ho.id, isDefault: true, ...addressData },
        });
      }
    }

    if (match.dpName) {
      const existingDp = await prisma.businessPartnerContact.findFirst({
        where: { businessPartnerId: ho.id, isMainContact: true },
      });
      const dpData = {
        name: match.dpName,
        email: match.dpEmail || undefined,
        phoneNumber: match.dpMobile || undefined,
        isMainContact: true,
      };
      if (existingDp) {
        await prisma.businessPartnerContact.update({
          where: { id: existingDp.id },
          data: dpData,
        });
      } else {
        await prisma.businessPartnerContact.create({
          data: { businessPartnerId: ho.id, ...dpData },
        });
      }
    }

    if (match.gmCeoName) {
      const existingOwner = await prisma.businessPartnerContact.findFirst({
        where: { businessPartnerId: ho.id, isOwner: true },
      });
      if (existingOwner) {
        await prisma.businessPartnerContact.update({
          where: { id: existingOwner.id },
          data: { name: match.gmCeoName },
        });
      } else {
        await prisma.businessPartnerContact.create({
          data: {
            businessPartnerId: ho.id,
            name: match.gmCeoName,
            isOwner: true,
          },
        });
      }
    }
  }

  if (unmatched.length > 0) {
    console.warn(
      `⚠ ${unmatched.length} HO rows had no matching Active_Dealer record (GST/address/contacts not populated):`,
      unmatched,
    );
  }
}

// ─────────────────────────────────────────────
// Orchestration
//
// Note: branches are NOT enriched with GST/PAN/address/contacts from
// Active_Dealer.xlsx or from their HO — neither source file has per-branch
// GST/PAN data, and branches are independent entities (own GST, own PAN,
// own address) that just happen to reference a parent HO via parentId.
// Nothing is copied down. If per-branch GST/PAN data becomes available
// later, load it the same way enrichHeadOffices does, keyed on branch code
// instead of HO code — don't revive the old propagate-from-parent approach.
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const branchWorkbook = XLSX.readFile(DEALERSHIP_BRANCHES_FILE);
  const branchRows = parseBranchSheet(
    branchWorkbook.Sheets["Dealership Branches"],
  );

  const activeDealerWorkbook = XLSX.readFile(ACTIVE_DEALER_FILE);
  const activeDealerRows = parseActiveDealerSheet(
    activeDealerWorkbook.Sheets["Sheet1"],
  ).filter(
    (r) => r.fullNameOfDealership, // drops the blank merged-cell artifact rows
  );

  console.log(
    `Loaded ${branchRows.length} branch rows, ${activeDealerRows.length} active dealer rows.`,
  );

  await loadBranchRows(branchRows);
  await enrichHeadOffices(activeDealerRows);

  console.log("Import complete.");
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

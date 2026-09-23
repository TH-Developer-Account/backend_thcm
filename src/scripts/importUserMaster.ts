/**
 * One-off data-migration script: loads C4C_THCM_Employee.csv and
 * Dealer_user_Details_BYD_.csv into the User table (HR/org fields live
 * directly on User, not a separate profile table).
 *
 * Run manually: npx ts-node src/scripts/importUserMaster.ts
 *
 * Grain: one login User per real person, deduped by email (falling back to
 * employeeCode+userType when email is missing) — NOT one row per CSV line.
 * Both source files contain job-history rows (the same person can appear
 * multiple times across different validity periods); the row with the latest
 * date per person "wins" and becomes that person's profile.
 *
 * All imported Users are created with isActive = false and a fixed default
 * password (isDefaultLogin = true), for manual review/activation — per
 * explicit instruction, not an inferred default.
 *
 * Partial-failure pattern: each person is processed independently and errors
 * are collected rather than aborting the whole run, matching the existing
 * bulk-import convention used elsewhere in this codebase.
 */
import * as fs from "fs";
import Papa from "papaparse";

import { prisma } from "../shared/config/prisma";

const C4C_FILE = "./src/scripts/data/C4C_THCM_Employee.csv";
const DEALER_FILE = "./src/scripts/data/Dealer_user_Details_BYD.csv";

// Fixed placeholder password for every imported account — stored as PLAIN TEXT
// for now (not hashed), per explicit instruction. See flag below.
const DEFAULT_PASSWORD = "Welcome@2026";

// ─────────────────────────────────────────────
// Unified shape both source files get parsed into
// ─────────────────────────────────────────────

interface PersonRecord {
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string | undefined;
  phoneNumber: string | undefined;
  region: string | undefined;
  zone: string | undefined;
  address: string | undefined;
  department: string | undefined;
  designation: string | undefined;
  managerCode1: string | undefined;
  managerCode2: string | undefined;
  c4cId: string | undefined;
  bydId: string | undefined;
  businessPartnerCode: string | undefined; // dealer: Company/Vendor Code column; C4C: Assigned Org Unit ID
  userType: string;
  joinedOn: Date | undefined;
}

// ─────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────

/**
 * Both source files use several placeholder markers for "no value", not just
 * blank cells: "#" everywhere, and "Not assigned" specifically in the dealer
 * (BYD) file's Department/Zone/Categories-style columns. Without stripping
 * these, "Not assigned" was passing straight through as if it were real data.
 */
function toNullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  if (str === "" || str === "#") return undefined;
  if (str.toLowerCase() === "not assigned") return undefined;
  return str;
}

/**
 * Source "phone" columns occasionally contain garbage that isn't a phone
 * number at all (e.g. an email-shaped string was seen in one Private Mobile
 * cell) — that garbage is often longer than the phone_number column allows
 * and makes Prisma reject the whole row with an opaque "value too long"
 * error. Strip to digits/leading-+ and reject anything that doesn't look
 * like a plausible phone number, rather than pass raw text through.
 */
function sanitizePhoneNumber(value: unknown): string | undefined {
  const raw = toNullableString(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digitCount = cleaned.replace(/\D/g, "").length;
  if (digitCount < 7 || digitCount > 15) return undefined; // not a plausible phone number
  return cleaned;
}

/** C4C dates are MM/DD/YYYY (e.g. "06/01/1997"). */
function parseC4CDate(value: unknown): Date | undefined {
  const str = toNullableString(value);
  if (!str) return undefined;
  const [month, day, year] = str.split("/").map(Number);
  if (!month || !day || !year) return undefined;
  return new Date(year, month - 1, day);
}

/** Dealer (BYD) dates are DD.MM.YYYY (e.g. "14.06.2023"). */
function parseDealerDate(value: unknown): Date | undefined {
  const str = toNullableString(value);
  if (!str) return undefined;
  const [day, month, year] = str.split(".").map(Number);
  if (!day || !month || !year) return undefined;
  return new Date(year, month - 1, day);
}

function readCsvRows(filePath: string): string[][] {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = Papa.parse<string[]>(content, {
    header: false,
    skipEmptyLines: true,
  });
  return parsed.data.slice(1); // drop header row — headers are unreliable (blank/duplicate), read by index instead
}

// ─────────────────────────────────────────────
// Phase 1 — parse both source files into PersonRecord[]
// ─────────────────────────────────────────────

function parseC4CRows(rows: string[][]): PersonRecord[] {
  return rows.map((r) => ({
    employeeCode: toNullableString(r[0]) ?? "",
    firstName: toNullableString(r[2]) ?? "",
    lastName: toNullableString(r[3]) ?? "",
    email: toNullableString(r[4])?.toLowerCase(),
    phoneNumber: sanitizePhoneNumber(r[20]) ?? sanitizePhoneNumber(r[21]),
    region: toNullableString(r[11]),
    zone: undefined, // no zone column in C4C source
    address: toNullableString(r[10]), // City only — partial address, see mapping doc
    department: toNullableString(r[14]) ?? toNullableString(r[13]),
    designation: toNullableString(r[17]) ?? toNullableString(r[16]),
    managerCode1: toNullableString(r[18]),
    managerCode2: undefined,
    c4cId: toNullableString(r[6]),
    bydId: undefined,
    businessPartnerCode: toNullableString(r[26]), // Assigned Org Unit ID — matched against BusinessPartner.bydId
    userType: "THCM",
    joinedOn: parseC4CDate(r[24]),
  }));
}

function parseDealerRows(rows: string[][]): PersonRecord[] {
  return rows.map((r) => ({
    employeeCode: toNullableString(r[2]) ?? "",
    firstName: toNullableString(r[10]) ?? "",
    lastName: toNullableString(r[13]) ?? "",
    email: toNullableString(r[23]),
    phoneNumber: sanitizePhoneNumber(r[24]) ?? sanitizePhoneNumber(r[25]),
    region: toNullableString(r[17]),
    zone: toNullableString(r[11]),
    address: undefined, // no address column in dealer source
    department: toNullableString(r[6]),
    designation: toNullableString(r[19]) ?? toNullableString(r[18]),
    managerCode1: toNullableString(r[7]), // Department Manager
    managerCode2: toNullableString(r[38]), // Reporting Line Unit Manager — Cost Center Manager dropped, see mapping doc
    c4cId: undefined,
    bydId: toNullableString(r[5]), // User ID — assumption, no dedicated BYD-ID column
    businessPartnerCode: toNullableString(r[0]), // Company/Vendor Code — matched against BusinessPartner.vendorId
    userType: "DEALER",
    joinedOn: parseDealerDate(r[15]), // Hire Date — assumption, see mapping doc
  }));
}

// ─────────────────────────────────────────────
// Phase 2 — dedupe to one record per real person
//
// Grouping key is email when present (lowercased), falling back to
// `${userType}:${employeeCode}` when email is missing. Within each group,
// the record with the latest joinedOn wins; records with no joinedOn sort last.
// ─────────────────────────────────────────────

function groupKey(record: PersonRecord): string {
  return record.email
    ? `email:${record.email.toLowerCase()}`
    : `code:${record.userType}:${record.employeeCode}`;
}

function dedupeToLatestPerPerson(records: PersonRecord[]): PersonRecord[] {
  const groups = new Map<string, PersonRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }

  const latestPerPerson: PersonRecord[] = [];
  for (const bucket of groups.values()) {
    const [latest] = bucket.sort(
      (a, b) => (b.joinedOn?.getTime() ?? 0) - (a.joinedOn?.getTime() ?? 0),
    );
    latestPerPerson.push(latest);
  }
  return latestPerPerson;
}

// ─────────────────────────────────────────────
// Phase 0 — resolve the single workspace once
//
// requireAuth (auth.middleware.ts) throws 403 for any User with no
// WorkspaceUser row at all — so every imported person needs one, not just
// super admins. This app is single-workspace today (see createSuperAdmin.ts),
// so we grab the only one and fail loudly if that assumption ever breaks.
// ─────────────────────────────────────────────

async function resolveSingleWorkspace() {
  const workspaces = await prisma.workspace.findMany();
  if (workspaces.length !== 1) {
    throw new Error(
      `Expected exactly one workspace, found ${workspaces.length}. Update this script to target a specific workspaceId instead of assuming there's only one.`,
    );
  }
  return workspaces[0];
}

// ─────────────────────────────────────────────
// findBusinessPartnerId
//
// The matching field depends on userType: dealer users match against
// BusinessPartner.vendorId (Company/Vendor Code), C4C/THCM users match
// against BusinessPartner.bydId (Assigned Org Unit ID). Neither field is
// unique in the schema, so findFirst rather than findUnique. No match ->
// undefined, logged, never guessed.
// ─────────────────────────────────────────────

async function findBusinessPartnerId(
  record: PersonRecord,
  unmatchedCodes: Set<string>,
): Promise<string | undefined> {
  if (!record.businessPartnerCode) return undefined;

  const bp = await prisma.businessPartner.findFirst({
    where:
      record.userType === "DEALER"
        ? { vendorId: record.businessPartnerCode }
        : { bydId: record.businessPartnerCode },
  });

  if (!bp)
    unmatchedCodes.add(`${record.userType}:${record.businessPartnerCode}`);
  return bp?.id;
}

// ─────────────────────────────────────────────
// Phase 3 — upsert User per person (all fields live on User directly, no
// separate profile table)
// ─────────────────────────────────────────────

async function findExistingUser(record: PersonRecord) {
  if (record.email) {
    const userByEmail = await prisma.user.findUnique({
      where: { email: record.email },
    });
    if (userByEmail) return userByEmail;
  }
  return prisma.user.findFirst({
    where: { employeeCode: record.employeeCode, userType: record.userType },
  });
}

async function upsertPerson(
  record: PersonRecord,
  businessPartnerId: string | undefined,
  workspaceId: string,
): Promise<void> {
  if (!record.firstName || !record.lastName) {
    throw new Error(
      `Missing first/last name (employeeCode=${record.employeeCode})`,
    );
  }

  const existingUser = await findExistingUser(record);

  const userData = {
    first_name: record.firstName,
    last_name: record.lastName,
    email: record.email ?? null,
    phone_number: record.phoneNumber ?? null,
    employeeCode: record.employeeCode,
    bydId: record.bydId,
    c4cId: record.c4cId,
    region: record.region,
    zone: record.zone,
    address: record.address,
    department: record.department,
    designation: record.designation,
    managerCode1: record.managerCode1,
    managerCode2: record.managerCode2,
    businessPartnerId,
    userType: record.userType,
    joinedOn: record.joinedOn,
  };

  let userId: string;

  if (existingUser) {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: userData,
    });
    userId = existingUser.id;
  } else {
    const created = await prisma.user.create({
      data: {
        ...userData,
        password: DEFAULT_PASSWORD, // plain text, not hashed — see flag at top of file
        is_active: false, // manual review/activation, per explicit instruction
        is_default_login: true, // forces password reset on first real login
      },
    });
    userId = created.id;
  }

  // Every user needs a WorkspaceUser row or requireAuth rejects them outright
  // with "User does not belong to any workspace" — not optional, not just
  // for super admins. isSuperAdmin is always false here; use
  // createSuperAdmin.ts to promote a specific account afterward.
  await prisma.workspaceUser.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, isSuperAdmin: false },
  });
}

// ─────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const workspace = await resolveSingleWorkspace();

  const c4cRecords = parseC4CRows(readCsvRows(C4C_FILE));
  const dealerRecords = parseDealerRows(readCsvRows(DEALER_FILE));

  console.log(
    `Parsed ${c4cRecords.length} C4C rows, ${dealerRecords.length} dealer rows.`,
  );

  const deduped = dedupeToLatestPerPerson([...c4cRecords, ...dealerRecords]);
  console.log(`Deduped to ${deduped.length} unique people.`);

  const errors: { employeeCode: string; userType: string; message: string }[] =
    [];
  const unmatchedBusinessPartners = new Set<string>();
  let reclassifiedCount = 0;

  for (const record of deduped) {
    try {
      const businessPartnerId = await findBusinessPartnerId(
        record,
        unmatchedBusinessPartners,
      );

      // A C4C row whose Assigned Org Unit ID actually matches a BusinessPartner
      // means this person works for a dealer org unit, not THCM itself — treat
      // them as DEALER instead. Dealer-sourced records are already DEALER, so
      // this only ever affects C4C rows.
      if (record.userType === "THCM" && businessPartnerId) {
        record.userType = "DEALER";
        reclassifiedCount++;
      }

      await upsertPerson(record, businessPartnerId, workspace.id);
    } catch (err: any) {
      errors.push({
        employeeCode: record.employeeCode,
        userType: record.userType,
        message: err.message,
      });
    }
  }

  if (reclassifiedCount > 0) {
    console.log(
      `${reclassifiedCount} C4C rows reclassified as DEALER (Assigned Org Unit ID matched a BusinessPartner).`,
    );
  }

  console.log(
    `Import complete: ${deduped.length - errors.length} succeeded, ${errors.length} failed.`,
  );
  if (errors.length > 0) {
    console.warn("⚠ Failed records:", errors);
  }
  if (unmatchedBusinessPartners.size > 0) {
    console.warn(
      `⚠ ${unmatchedBusinessPartners.size} users reference a BP code with no matching BusinessPartner, loaded with businessPartnerId = null (format is "userType:code"):`,
      [...unmatchedBusinessPartners],
    );
  }
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

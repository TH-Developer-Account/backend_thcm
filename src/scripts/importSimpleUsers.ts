/**
 * One-off data-migration script: loads a simple xlsx (First Name, Last Name,
 * Phone, Email only) into the User table.
 *
 * Run manually: npx ts-node src/scripts/importSimpleUsers.ts
 *
 * Unlike importUserMaster.ts (C4C/Dealer sources), this source carries no
 * employeeCode, no BusinessPartner code, no manager/department/date fields —
 * so there is no BP matching and no employeeCode fallback key. Email is the
 * only identity this source has, so it is required: a row with no email
 * cannot be matched against an existing User (email is @unique on User) and
 * cannot be deduped against other rows in the same file, so it is skipped
 * and logged rather than guessed at.
 *
 * All imported Users are created with isActive = false and a fixed default
 * password (isDefaultLogin = true), for manual review/activation — matching
 * importUserMaster.ts's convention, per explicit instruction.
 */
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";

// TODO: replace with the real file once it's added under scripts/data/
const SIMPLE_USERS_FILE = "./src/scripts/data/New_Users.xlsx";

// Fixed placeholder password for every imported account — stored as PLAIN
// TEXT for now (not hashed), per explicit instruction. See flag below.
const DEFAULT_PASSWORD = "Welcome@2026";

// ─────────────────────────────────────────────
// Row shape
// ─────────────────────────────────────────────

interface SimpleUserRow {
  firstName: string;
  lastName: string;
  phoneNumber: string | undefined;
  email: string | undefined;
}

// ─────────────────────────────────────────────
// Pure helpers — no I/O, easy to unit test independently
// ─────────────────────────────────────────────

function toNullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  if (str === "" || str === "#") return undefined;
  if (str.toLowerCase() === "not assigned") return undefined;
  return str;
}

/**
 * Same validity check as importUserMaster.ts: strip to digits/leading-+ and
 * reject anything that doesn't look like a plausible phone number, rather
 * than pass raw text through and risk Prisma rejecting the whole row on a
 * column-length error.
 */
function sanitizePhoneNumber(value: unknown): string | undefined {
  const raw = toNullableString(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digitCount = cleaned.replace(/\D/g, "").length;
  if (digitCount < 7 || digitCount > 15) return undefined; // not a plausible phone number
  return cleaned;
}

/**
 * Columns are read by fixed index (First Name=0, Last Name=1, Phone=2,
 * Email=3), matching this codebase's existing convention of not trusting
 * source headers (see importUserMaster.ts, importBusinessPartners.ts).
 */
function parseSimpleUserSheet(sheet: XLSX.WorkSheet): SimpleUserRow[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  return rows.slice(1).map((r) => ({
    firstName: toNullableString(r[0]) ?? "",
    lastName: toNullableString(r[1]) ?? "",
    phoneNumber: sanitizePhoneNumber(r[2]),
    email: toNullableString(r[3])?.toLowerCase(),
  }));
}

// ─────────────────────────────────────────────
// Phase 0 — resolve the single workspace once
//
// requireAuth (auth.middleware.ts) throws 403 for any User with no
// WorkspaceUser row at all — so every imported person needs one. This app
// is single-workspace today (see createSuperAdmin.ts), so we grab the only
// one and fail loudly if that assumption ever breaks.
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
// Phase 1 — upsert User per row, matched by email only
// ─────────────────────────────────────────────

async function upsertSimpleUser(
  row: SimpleUserRow,
  workspaceId: string,
): Promise<void> {
  const existingUser = await prisma.user.findUnique({
    where: { email: row.email! }, // non-null: caller has already filtered rows with no email
  });

  const userData = {
    first_name: row.firstName,
    last_name: row.lastName,
    email: row.email!,
    phone_number: row.phoneNumber ?? null,
    userType: "THCM",
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
  // with "User does not belong to any workspace" — not optional.
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

  const workbook = XLSX.readFile(SIMPLE_USERS_FILE);
  const rows = parseSimpleUserSheet(workbook.Sheets[workbook.SheetNames[0]]);

  console.log(`Parsed ${rows.length} rows from ${SIMPLE_USERS_FILE}.`);

  const skipped: { row: number; reason: string }[] = [];
  const errors: { row: number; email: string | undefined; message: string }[] =
    [];

  let processed = 0;

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; // +1 for 0-index, +1 for header row

    if (!row.firstName || !row.lastName) {
      skipped.push({ row: rowNumber, reason: "missing first/last name" });
      continue;
    }
    if (!row.email) {
      skipped.push({ row: rowNumber, reason: "missing email" });
      continue;
    }

    try {
      await upsertSimpleUser(row, workspace.id);
      processed++;
    } catch (err: any) {
      errors.push({ row: rowNumber, email: row.email, message: err.message });
    }
  }

  console.log(
    `Import complete: ${processed} succeeded, ${skipped.length} skipped, ${errors.length} failed.`,
  );
  if (skipped.length > 0) {
    console.warn("⚠ Skipped rows:", skipped);
  }
  if (errors.length > 0) {
    console.warn("⚠ Failed rows:", errors);
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

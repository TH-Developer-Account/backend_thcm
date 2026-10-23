/**
 * One-off data-migration script: syncs email, phone number, and grade onto
 * existing THCM-employee Users from two HR sources, and creates a new User
 * for any employeeCode EOR knows about that isn't in the DB yet.
 *
 * Run manually: npx ts-node src/scripts/updateUserHrData.ts
 *
 * Sources:
 *  - EOR_31.08.xls, parsed via the shared ./lib/eorSource (also used by
 *    backfillHrMasters.ts, which needs Designation/Division/Cost Center from
 *    the same file). Only employeeCode/name/grade/email are used in THIS
 *    script — Designation/Division/Cost Center/Location stay out of scope
 *    for the User-record sync (see claude/decisions-and-learnings.md); they
 *    feed the separate Division/Designation/CostCenter masters instead.
 *  - Company_provided_mobile_number_2.xlsx ("Non-plant") and
 *    Copy_of_Company_provided_mobile_number.xlsx ("Dharwad Plant") — phone
 *    numbers only. Both share the same column layout: T.No., Name, CC,
 *    Grade, Division, Location, Mobile No. Only T.No./Mobile No. are used —
 *    their own Grade/Division/Location columns are ignored; EOR is the
 *    single source of truth for those.
 *
 * Matching: by employeeCode, restricted to userType = "THCM" — these sources
 * are internal plant/HR data and have no bearing on DEALER users.
 *
 * Conflict policy (unique constraints on User.email / User.phone_number): if
 * a value from the source file already belongs to a DIFFERENT user, that one
 * field is skipped and logged — never reassigned, never blanked.
 *
 * Grades: for every distinct non-null Grade value seen in EOR, a
 * GradeEligibility row is ensured to exist, inserted with annualCap = null
 * when missing (EOR carries no cap amount — see the schema comment on
 * GradeEligibility for why null, not 0).
 *
 * Location/Designation/Division/Cost Center are now FK columns on User
 * (locationId/designationId/divisionId/costCenterId), resolved from EOR's
 * Location/Designation/Division/Cost Center columns via the shared
 * resolveOrCreateByName/resolveOrCreateCostCenter helpers (./lib/
 * masterResolvers) — find-or-create by normalized name, same policy
 * backfillHrMasters.ts uses to seed these masters in bulk. Always
 * overwritten on every run, same policy as email/grade above. Zone is NOT
 * touched by this script — no zone column in EOR; it's admin-assigned only.
 *
 * Mobile-file rows with no matching User (employeeCode not found under
 * userType "THCM", whether or not EOR also mentions it) are skipped and
 * logged — no new users are created from the mobile files alone.
 */
import * as XLSX from "xlsx";

import { prisma } from "../shared/config/prisma";
import { parseEorRows, type EorRecord } from "./helpers/eorSource";
import { toNullableString, sanitizePhoneNumber } from "./helpers/parseHelpers";
import {
  resolveOrCreateByName,
  resolveOrCreateCostCenter,
} from "./helpers/masterResolvers";

const EOR_FILE = "./src/scripts/data/EOR_31.08.xls";
const MOBILE_NON_PLANT_FILE =
  "./src/scripts/data/Company_provided_mobile_number.xlsx";
const MOBILE_DHARWAD_FILE =
  "./src/scripts/data/Copy_of_Company_provided_mobile_number.xlsx";

const MOBILE_NON_PLANT_SHEET = "Non-plant";
const MOBILE_DHARWAD_SHEET = "Dharwad Plant";

// Fixed placeholder password for every newly created account — stored as
// PLAIN TEXT for now (not hashed), matching importUserMaster.ts's convention.
const DEFAULT_PASSWORD = "Welcome@2026";
const USER_TYPE = "THCM";

// ─────────────────────────────────────────────
// Unified shapes
//
// EorRecord itself (parseEorRows) and the toNullableString/sanitizePhoneNumber
// helpers now live in ./lib/eorSource and ./lib/parseHelpers — shared with
// backfillHrMasters.ts, which parses the same EOR file for different
// columns. This script only needs PhoneRecord locally.
// ─────────────────────────────────────────────

interface PhoneRecord {
  employeeCode: string;
  phone: string | undefined;
}

// ─────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────

/**
 * EOR's "Name" is one combined field. Split as first-word/rest, per
 * explicit instruction. A single-word name has no "rest" — last_name is
 * required on User, so it falls back to repeating the first word rather
 * than being left blank.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const [firstName, ...rest] = parts;
  const lastName = rest.join(" ");
  return { firstName, lastName: lastName || firstName };
}

// ─────────────────────────────────────────────
// Phase 1 — parse source files (EOR via the shared parseEorRows)
// ─────────────────────────────────────────────

/**
 * Both mobile-number sheets share the same column layout: T.No.(0),
 * Name(1), CC(2), Grade(3), Division(4), Location(5), Mobile No.(6). Read by
 * fixed index, same convention as every other import script here — only
 * T.No./Mobile No. are used.
 */
function parsePhoneSheet(sheet: XLSX.WorkSheet): PhoneRecord[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  return rows.slice(1).map((r) => ({
    employeeCode: toNullableString(r[0]) ?? "",
    phone: sanitizePhoneNumber(r[6]),
  }));
}

function parsePhoneFile(filePath: string, sheetName: string): PhoneRecord[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);
  }
  return parsePhoneSheet(sheet);
}

// ─────────────────────────────────────────────
// Phase 2 — ensure a GradeEligibility row exists for every grade EOR
// mentions, inserted with annualCap = null (no cap amount in EOR — see the
// schema comment on GradeEligibility) rather than touched per-row in the
// main loop, since it's a one-time, grade-level concern, not a per-user one.
// ─────────────────────────────────────────────

async function ensureGradeEligibilityRows(
  grades: Set<string>,
): Promise<string[]> {
  const existing = await prisma.gradeEligibility.findMany({
    select: { grade: true },
  });
  const existingGrades = new Set(existing.map((g) => g.grade));
  const newGrades = [...grades].filter((g) => !existingGrades.has(g));

  for (const grade of newGrades) {
    await prisma.gradeEligibility.create({ data: { grade, annualCap: null } });
  }
  return newGrades;
}

/**
 * Resolves this EOR record's Location/Designation/Division/Cost Center
 * into the matching master row id, creating the master row if this is the
 * first time that value has been seen (same find-or-create policy
 * backfillHrMasters.ts uses). Only present keys are the ones EOR actually
 * has a value for — a blank EOR cell leaves that FK untouched rather than
 * nulling out whatever the user already had.
 */
async function resolveOrgFks(record: EorRecord): Promise<{
  locationId?: string;
  designationId?: string;
  divisionId?: string;
  costCenterId?: string;
}> {
  const updates: {
    locationId?: string;
    designationId?: string;
    divisionId?: string;
    costCenterId?: string;
  } = {};

  if (record.location) {
    updates.locationId = await resolveOrCreateByName(
      "userRegion",
      record.location,
    );
  }
  if (record.designation) {
    updates.designationId = await resolveOrCreateByName(
      "designation",
      record.designation,
    );
  }
  if (record.division) {
    updates.divisionId = await resolveOrCreateByName(
      "division",
      record.division,
    );
  }
  if (record.costCenterCode) {
    updates.costCenterId = await resolveOrCreateCostCenter(
      record.costCenterCode,
      record.costCenterName,
    );
  }

  return updates;
}

// ─────────────────────────────────────────────
// Phase 0 — resolve the single workspace once (new users need a
// WorkspaceUser row or requireAuth rejects them — same as importUserMaster.ts)
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

async function findThcmUserByEmployeeCode(employeeCode: string) {
  return prisma.user.findFirst({
    where: { employeeCode, userType: USER_TYPE },
  });
}

/** The id of whoever currently holds this email, if anyone. */
async function findEmailHolder(email: string): Promise<string | undefined> {
  const holder = await prisma.user.findUnique({ where: { email } });
  return holder?.id;
}

/**
 * The id of a DIFFERENT user already holding this email, if any. Pass
 * `ownUserId: undefined` for a not-yet-created user, where ANY holder at
 * all is a conflict.
 */
async function findEmailConflict(
  email: string,
  ownUserId: string | undefined,
): Promise<string | undefined> {
  const holderId = await findEmailHolder(email);
  return holderId && holderId !== ownUserId ? holderId : undefined;
}

/** Returns the id of a DIFFERENT user already holding this phone, if any. */
async function findPhoneConflict(
  phone: string,
  ownUserId: string,
): Promise<string | undefined> {
  const holder = await prisma.user.findUnique({
    where: { phone_number: phone },
  });
  return holder && holder.id !== ownUserId ? holder.id : undefined;
}

// ─────────────────────────────────────────────
// Phase 3 — EOR pass: update matched users, create unmatched ones
// ─────────────────────────────────────────────

interface EorOutcome {
  created: number;
  updated: number;
  emailConflicts: { employeeCode: string; email: string; heldBy: string }[];
  skipped: { employeeCode: string; reason: string }[];
  errors: { employeeCode: string; message: string }[];
}

async function runEorPass(
  records: EorRecord[],
  workspaceId: string,
): Promise<EorOutcome> {
  const outcome: EorOutcome = {
    created: 0,
    updated: 0,
    emailConflicts: [],
    skipped: [],
    errors: [],
  };

  for (const record of records) {
    if (!record.employeeCode) {
      outcome.skipped.push({
        employeeCode: "",
        reason: "missing Personnel Number",
      });
      continue;
    }

    try {
      const existingUser = await findThcmUserByEmployeeCode(
        record.employeeCode,
      );

      if (existingUser) {
        const updateData: {
          email?: string;
          grade?: string;
          locationId?: string;
          designationId?: string;
          divisionId?: string;
          costCenterId?: string;
        } = {};

        if (record.email) {
          const conflictHolderId = await findEmailConflict(
            record.email,
            existingUser.id,
          );
          if (conflictHolderId) {
            outcome.emailConflicts.push({
              employeeCode: record.employeeCode,
              email: record.email,
              heldBy: conflictHolderId,
            });
          } else {
            updateData.email = record.email; // always overwrite, per instruction
          }
        }
        if (record.grade) updateData.grade = record.grade;

        const orgFkUpdates = await resolveOrgFks(record);
        Object.assign(updateData, orgFkUpdates);

        if (Object.keys(updateData).length > 0) {
          await prisma.user.update({
            where: { id: existingUser.id },
            data: updateData,
          });
          outcome.updated++;
        }
        continue;
      }

      // Not found — create a new THCM user from EOR alone.
      if (!record.name) {
        outcome.skipped.push({
          employeeCode: record.employeeCode,
          reason: "no existing user and no Name to create one from",
        });
        continue;
      }

      if (record.email) {
        const conflictHolderId = await findEmailConflict(
          record.email,
          undefined, // no own id yet — any holder at all is a conflict
        );
        if (conflictHolderId) {
          outcome.emailConflicts.push({
            employeeCode: record.employeeCode,
            email: record.email,
            heldBy: conflictHolderId,
          });
          outcome.skipped.push({
            employeeCode: record.employeeCode,
            reason: `email ${record.email} already belongs to a different user — new user not created`,
          });
          continue;
        }
      }

      const { firstName, lastName } = splitName(record.name);
      const orgFks = await resolveOrgFks(record);
      const created = await prisma.user.create({
        data: {
          first_name: firstName,
          last_name: lastName,
          email: record.email ?? null,
          employeeCode: record.employeeCode,
          grade: record.grade,
          userType: USER_TYPE,
          password: DEFAULT_PASSWORD, // plain text, not hashed — see flag at top of file
          is_active: false, // manual review/activation, per existing convention
          is_default_login: true, // forces password reset on first real login
          ...orgFks,
        },
      });

      await prisma.workspaceUser.upsert({
        where: { userId_workspaceId: { userId: created.id, workspaceId } },
        update: {},
        create: { userId: created.id, workspaceId, isSuperAdmin: false },
      });

      outcome.created++;
    } catch (err: any) {
      outcome.errors.push({
        employeeCode: record.employeeCode,
        message: err.message,
      });
    }
  }

  return outcome;
}

// ─────────────────────────────────────────────
// Phase 4 — mobile-file pass: phone numbers for already-known THCM users only
// ─────────────────────────────────────────────

interface PhoneOutcome {
  updated: number;
  phoneConflicts: { employeeCode: string; phone: string; heldBy: string }[];
  unmatched: string[];
  errors: { employeeCode: string; message: string }[];
}

async function runPhonePass(records: PhoneRecord[]): Promise<PhoneOutcome> {
  const outcome: PhoneOutcome = {
    updated: 0,
    phoneConflicts: [],
    unmatched: [],
    errors: [],
  };

  for (const record of records) {
    if (!record.employeeCode || !record.phone) continue;

    try {
      const user = await findThcmUserByEmployeeCode(record.employeeCode);
      if (!user) {
        outcome.unmatched.push(record.employeeCode);
        continue;
      }

      const conflictHolderId = await findPhoneConflict(record.phone, user.id);
      if (conflictHolderId) {
        outcome.phoneConflicts.push({
          employeeCode: record.employeeCode,
          phone: record.phone,
          heldBy: conflictHolderId,
        });
        continue;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { phone_number: record.phone },
      });
      outcome.updated++;
    } catch (err: any) {
      outcome.errors.push({
        employeeCode: record.employeeCode,
        message: err.message,
      });
    }
  }

  return outcome;
}

// ─────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const workspace = await resolveSingleWorkspace();

  const eorRecords = parseEorRows(EOR_FILE);
  const phoneRecords = [
    ...parsePhoneFile(MOBILE_NON_PLANT_FILE, MOBILE_NON_PLANT_SHEET),
    ...parsePhoneFile(MOBILE_DHARWAD_FILE, MOBILE_DHARWAD_SHEET),
  ];

  console.log(
    `Parsed ${eorRecords.length} EOR rows, ${phoneRecords.length} mobile-file rows.`,
  );

  const distinctGrades = new Set(
    eorRecords.map((r) => r.grade).filter((g): g is string => Boolean(g)),
  );
  const newGrades = await ensureGradeEligibilityRows(distinctGrades);
  if (newGrades.length > 0) {
    console.log(
      `Inserted ${newGrades.length} new GradeEligibility row(s) with annualCap = null (needs manual entry):`,
      newGrades,
    );
  }

  const eorOutcome = await runEorPass(eorRecords, workspace.id);
  console.log(
    `EOR pass: ${eorOutcome.created} created, ${eorOutcome.updated} updated, ${eorOutcome.skipped.length} skipped, ${eorOutcome.errors.length} failed.`,
  );
  if (eorOutcome.emailConflicts.length > 0) {
    console.warn(
      `⚠ ${eorOutcome.emailConflicts.length} EOR email(s) already belonged to a different user — left untouched:`,
      eorOutcome.emailConflicts,
    );
  }
  if (eorOutcome.skipped.length > 0) {
    console.warn("⚠ Skipped EOR rows:", eorOutcome.skipped);
  }
  if (eorOutcome.errors.length > 0) {
    console.warn("⚠ Failed EOR rows:", eorOutcome.errors);
  }

  const phoneOutcome = await runPhonePass(phoneRecords);
  console.log(
    `Phone pass: ${phoneOutcome.updated} updated, ${phoneOutcome.unmatched.length} unmatched, ${phoneOutcome.errors.length} failed.`,
  );
  if (phoneOutcome.phoneConflicts.length > 0) {
    console.warn(
      `⚠ ${phoneOutcome.phoneConflicts.length} mobile number(s) already belonged to a different user — left untouched:`,
      phoneOutcome.phoneConflicts,
    );
  }
  if (phoneOutcome.unmatched.length > 0) {
    console.warn(
      `⚠ ${phoneOutcome.unmatched.length} mobile-file employeeCode(s) have no matching THCM user — no user created, per instruction:`,
      phoneOutcome.unmatched,
    );
  }
  if (phoneOutcome.errors.length > 0) {
    console.warn("⚠ Failed phone rows:", phoneOutcome.errors);
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

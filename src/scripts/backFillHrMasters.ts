/**
 * One-off data-migration script: populates the Division/Designation/
 * CostCenter lookup tables (see the "HR MASTERS" block in schema.prisma)
 * from EOR_31.08.xls.
 *
 * Run manually: npx ts-node src/scripts/backfillHrMasters.ts
 *
 * This is purely additive to these three master tables — it never reads
 * from or writes to User rows. All three are seeded from EOR alone: this
 * app's User.designation/division/costCenter are a dev environment and
 * were reset to FK columns with no data-preservation requirement (see
 * decisions-and-learnings.md), so there's no "also merge in whatever was
 * already on User rows" step here, unlike an earlier version of this
 * script.
 *
 * User.location is NOT backfilled here (and has no master table at all) —
 * it's plain free text on User directly; EOR's Location column is written
 * straight onto User.location by updateUserHrData.ts/importUserMaster.ts,
 * no find-or-create step needed.
 *
 * Insert-if-missing only, for all three masters — an existing row (whether
 * seeded here before, or hand-edited later through the Masters admin UI) is
 * never overwritten. Safe to re-run.
 *
 * Dedup policy for Division/Designation (free text, genuinely messy across
 * sources — inconsistent case, punctuation, spacing): two raw values are
 * treated as the same entry when they collapse to the same normalized key
 * (trim + collapse whitespace + uppercase, see ./lib/parseHelpers
 * normalizeKey). The first-seen cleaned (case-preserving) value for a given
 * key is what gets stored as the display name. This can over-merge two
 * genuinely different titles that only differ by how someone typed them —
 * that's the accepted tradeoff over minting a pile of near-duplicate rows;
 * review the inserted list afterward.
 *
 * Cost Center has an actual code (not free text) — it's keyed by that code
 * directly, no normalization needed; EOR's Cost Center Name for that code
 * is stored as-is.
 *
 * Zone is NOT backfilled here — no import source (EOR or the mobile files)
 * carries zone data; it's purely admin-managed through the Masters UI.
 */
import { prisma } from "../shared/config/prisma";
import { parseEorRows } from "./helpers/eorSource";
import { normalizeKey, cleanDisplayValue } from "./helpers/parseHelpers";

const EOR_FILE = "./src/scripts/data/EOR_31.08.xls";

type NameOnlyMaster = "division" | "designation";

// ─────────────────────────────────────────────
// Phase 1 — collect candidate values
// ─────────────────────────────────────────────

/**
 * Reduces a list of raw strings to one display value per normalized key,
 * first-seen wins. Order callers pass values in decides which casing is
 * kept when two sources disagree only by case/spacing.
 */
function dedupeByNormalizedKey(values: string[]): Map<string, string> {
  const byKey = new Map<string, string>(); // normalized key -> display value
  for (const raw of values) {
    const key = normalizeKey(raw);
    if (!byKey.has(key)) byKey.set(key, cleanDisplayValue(raw));
  }
  return byKey;
}

// ─────────────────────────────────────────────
// Phase 2 — insert-if-missing into each master, by normalized key
// ─────────────────────────────────────────────

async function backfillNameOnlyMaster(
  modelName: NameOnlyMaster,
  candidates: Map<string, string>,
): Promise<string[]> {
  const model = (prisma as any)[modelName] as {
    findMany: (args: any) => Promise<{ name: string }[]>;
    create: (args: any) => Promise<unknown>;
  };

  const existing = await model.findMany({ select: { name: true } });
  const existingKeys = new Set(existing.map((row) => normalizeKey(row.name)));

  const inserted: string[] = [];
  for (const [key, displayName] of candidates) {
    if (existingKeys.has(key)) continue;
    await model.create({ data: { name: displayName } });
    inserted.push(displayName);
  }
  return inserted;
}

async function backfillCostCenters(
  records: { code: string; name: string }[],
): Promise<string[]> {
  const existing = await prisma.costCenter.findMany({ select: { code: true } });
  const existingCodes = new Set(existing.map((row) => row.code));

  // First-seen name per code, same "don't overwrite, don't duplicate"
  // posture as the name-only masters.
  const byCode = new Map<string, string>();
  for (const record of records) {
    if (!byCode.has(record.code)) byCode.set(record.code, record.name);
  }

  const inserted: string[] = [];
  for (const [code, name] of byCode) {
    if (existingCodes.has(code)) continue;
    await prisma.costCenter.create({ data: { code, name } });
    inserted.push(`${code} (${name})`);
  }
  return inserted;
}

// ─────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const eorRecords = parseEorRows(EOR_FILE);
  console.log(`Parsed ${eorRecords.length} EOR rows.`);

  const divisionCandidates = dedupeByNormalizedKey(
    eorRecords.map((r) => r.division).filter((v): v is string => Boolean(v)),
  );
  const designationCandidates = dedupeByNormalizedKey(
    eorRecords.map((r) => r.designation).filter((v): v is string => Boolean(v)),
  );
  const costCenterRecords = eorRecords
    .filter((r) => r.costCenterCode && r.costCenterName)
    .map((r) => ({
      code: r.costCenterCode as string,
      name: r.costCenterName as string,
    }));

  console.log(
    `Candidates after dedup: ${divisionCandidates.size} divisions, ${designationCandidates.size} designations, ${new Set(costCenterRecords.map((r) => r.code)).size} cost centers.`,
  );

  const insertedDivisions = await backfillNameOnlyMaster(
    "division",
    divisionCandidates,
  );
  const insertedDesignations = await backfillNameOnlyMaster(
    "designation",
    designationCandidates,
  );
  const insertedCostCenters = await backfillCostCenters(costCenterRecords);

  console.log(
    `Inserted ${insertedDivisions.length} new Division row(s):`,
    insertedDivisions,
  );
  console.log(
    `Inserted ${insertedDesignations.length} new Designation row(s):`,
    insertedDesignations,
  );
  console.log(
    `Inserted ${insertedCostCenters.length} new CostCenter row(s):`,
    insertedCostCenters,
  );
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

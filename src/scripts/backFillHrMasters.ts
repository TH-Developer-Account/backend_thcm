/**
 * One-off data-migration script: populates the Division/Designation/
 * CostCenter/Vertical lookup tables (see the "HR MASTERS" block in
 * schema.prisma) from EOR_31.08.xls.
 *
 * Run manually: npx ts-node src/scripts/backfillHrMasters.ts
 *
 * This is purely additive to these four master tables — it never reads
 * from or writes to User rows. All four are seeded from EOR alone: this
 * app's User.designation/division/costCenter are a dev environment and
 * were reset to FK columns with no data-preservation requirement (see
 * decisions-and-learnings.md), so there's no "also merge in whatever was
 * already on User rows" step here, unlike an earlier version of this
 * script. (User.vertical stays plain free text — not touched here either,
 * same as User.location below.)
 *
 * User.location is NOT backfilled here (and has no master table at all) —
 * it's plain free text on User directly; EOR's Location column is written
 * straight onto User.location by updateUserHrData.ts/importUserMaster.ts,
 * no find-or-create step needed.
 *
 * Insert-if-missing only, for all four masters — an existing row (whether
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
 * Vertical uses the same normalized-key dedup as Division/Designation, but
 * scoped per Division rather than flat: the same Vertical name genuinely
 * recurs under more than one Division in EOR (e.g. "ASSEMBLY" under both
 * PRODUCTION - DHARWAD and PRODUCTION - KHARAGPUR), so the dedup key is
 * (divisionId, normalizeKey(name)) — see schema.prisma's
 * @@unique([name, divisionId]) on Vertical. A row whose Division doesn't
 * resolve to an existing Division row (name mismatch, or Division backfill
 * somehow didn't run first) is skipped rather than guessed at.
 *
 * Cost Center has an actual code (not free text) — it's keyed by that code
 * directly, no normalization needed; EOR's Cost Center Name for that code
 * is stored as-is.
 *
 * Zone is NOT backfilled here — no import source (EOR or the mobile files)
 * carries zone data; it's purely admin-managed through the Masters UI.
 */
import { prisma } from "../shared/config/prisma";
import { parseEorRows, EorRecord } from "./helpers/eorSource";
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

/**
 * Division name -> id, keyed by the same normalized key used for dedup, so
 * a Vertical row's raw "division" string can be resolved to the Division
 * row it belongs under (including a Division inserted earlier in this same
 * run, since this reads after backfillNameOnlyMaster("division", ...) has
 * already run).
 */
async function resolveDivisionIdMap(): Promise<Map<string, string>> {
  const divisions = await prisma.division.findMany({
    select: { id: true, name: true },
  });
  const byKey = new Map<string, string>();
  for (const division of divisions) {
    byKey.set(normalizeKey(division.name), division.id);
  }
  return byKey;
}

interface VerticalCandidate {
  divisionId: string;
  displayName: string;
}

/**
 * Compound-keyed the same way Vertical's @@unique([name, divisionId]) is:
 * `${divisionId}::${normalizeKey(name)}`. Rows with no vertical, no
 * division, or a division that doesn't resolve to an existing Division row
 * are skipped — logged by the caller via the returned skip count.
 */
function collectVerticalCandidates(
  records: EorRecord[],
  divisionIdByKey: Map<string, string>,
): { candidates: Map<string, VerticalCandidate>; skipped: number } {
  const candidates = new Map<string, VerticalCandidate>();
  let skipped = 0;

  for (const record of records) {
    if (!record.vertical || !record.division) continue;

    const divisionId = divisionIdByKey.get(normalizeKey(record.division));
    if (!divisionId) {
      skipped++;
      continue;
    }

    const key = `${divisionId}::${normalizeKey(record.vertical)}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        divisionId,
        displayName: cleanDisplayValue(record.vertical),
      });
    }
  }

  return { candidates, skipped };
}

async function backfillVerticals(
  candidates: Map<string, VerticalCandidate>,
): Promise<string[]> {
  const existing = await prisma.vertical.findMany({
    select: { name: true, divisionId: true },
  });
  const existingKeys = new Set(
    existing.map((row) => `${row.divisionId}::${normalizeKey(row.name)}`),
  );

  const inserted: string[] = [];
  for (const [key, candidate] of candidates) {
    if (existingKeys.has(key)) continue;
    await prisma.vertical.create({
      data: { name: candidate.displayName, divisionId: candidate.divisionId },
    });
    inserted.push(candidate.displayName);
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

  // Vertical depends on Division already being resolvable — run after the
  // Division backfill above so a brand-new Division from this same EOR file
  // is already in the lookup map.
  const divisionIdByKey = await resolveDivisionIdMap();
  const { candidates: verticalCandidates, skipped: skippedVerticalRows } =
    collectVerticalCandidates(eorRecords, divisionIdByKey);
  const insertedVerticals = await backfillVerticals(verticalCandidates);

  console.log(
    `Inserted ${insertedVerticals.length} new Vertical row(s):`,
    insertedVerticals,
  );
  if (skippedVerticalRows > 0) {
    console.log(
      `Skipped ${skippedVerticalRows} EOR row(s) with a Vertical whose Division didn't resolve to an existing Division row.`,
    );
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

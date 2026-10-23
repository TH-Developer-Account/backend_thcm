/**
 * Shared "find or create the master row for this free-text value" helper —
 * used by backfillHrMasters.ts (bulk seeding), updateUserHrData.ts and
 * importUserMaster.ts (per-user FK resolution while syncing/importing
 * Users). Three real consumers is what crosses this codebase's own
 * "two or more variants earn one" bar for extracting a shared helper.
 *
 * Division/Designation/UserRegion are all {id, name}-shaped lookups,
 * matched by normalizeKey (trim + collapse whitespace + uppercase) so
 * "Sales Manager" and "sales  manager" resolve to the same row — same
 * policy as backfillHrMasters.ts's own dedupeByNormalizedKey. CostCenter and
 * Zone are different: each is keyed by a real, unique code rather than a
 * normalized name alone, so they get their own resolvers below.
 *
 * In-memory per-model cache: without it, resolving these FKs inside a
 * per-row import/sync loop (thousands of EOR/CSV rows) would re-fetch the
 * entire master table on every single row. The cache is built lazily on
 * first use and kept warm for the life of the process — correct for a
 * one-off script (single process, no concurrent writers), not intended for
 * use inside a long-running server.
 */
import { prisma } from "../../shared/config/prisma";
import { normalizeKey, cleanDisplayValue } from "./parseHelpers";

export type NameOnlyMasterModel = "division" | "designation" | "userRegion";

type NameOnlyModelClient = {
  findMany: (args: {
    select: { id: true; name: true };
  }) => Promise<{ id: string; name: string }[]>;
  create: (args: { data: { name: string } }) => Promise<{ id: string }>;
};

const nameKeyCaches = new Map<NameOnlyMasterModel, Map<string, string>>();

async function getNameKeyCache(
  modelName: NameOnlyMasterModel,
): Promise<Map<string, string>> {
  const cached = nameKeyCaches.get(modelName);
  if (cached) return cached;

  const model = (prisma as unknown as Record<string, NameOnlyModelClient>)[
    modelName
  ];
  const rows = await model.findMany({ select: { id: true, name: true } });
  const map = new Map(rows.map((row) => [normalizeKey(row.name), row.id]));
  nameKeyCaches.set(modelName, map);
  return map;
}

/**
 * Returns the id of the master row matching `rawName` (by normalized key),
 * creating one with the cleaned (case-preserving) display value if this is
 * the first time this value has been seen.
 */
export async function resolveOrCreateByName(
  modelName: NameOnlyMasterModel,
  rawName: string,
): Promise<string> {
  const key = normalizeKey(rawName);
  const cache = await getNameKeyCache(modelName);

  const existingId = cache.get(key);
  if (existingId) return existingId;

  const model = (prisma as unknown as Record<string, NameOnlyModelClient>)[
    modelName
  ];
  const created = await model.create({
    data: { name: cleanDisplayValue(rawName) },
  });
  cache.set(key, created.id);
  return created.id;
}

const costCenterCodeCache = new Map<string, string>(); // code -> id

/** Cost Center is keyed by EOR's real code, not a normalized name. */
export async function resolveOrCreateCostCenter(
  code: string,
  name: string | undefined,
): Promise<string> {
  if (costCenterCodeCache.size === 0) {
    const rows = await prisma.costCenter.findMany({
      select: { id: true, code: true },
    });
    for (const row of rows) costCenterCodeCache.set(row.code, row.id);
  }

  const existingId = costCenterCodeCache.get(code);
  if (existingId) return existingId;

  const created = await prisma.costCenter.create({
    data: { code, name: name ?? code },
  });
  costCenterCodeCache.set(code, created.id);
  return created.id;
}

// Zone (formerly the separate Region master — same table now; see
// schema.prisma's Zone model comment) doesn't fit resolveOrCreateByName's
// {id, name} shape: its columns are region_code (unique, required) and
// region_name. region_code is never supplied by the legacy free-text
// region/zone values being resolved here, so this resolver also generates
// one for any newly auto-created zone.
const zoneNameKeyCache = new Map<string, string>(); // normalizeKey(region_name) -> id
let zoneCodeCache: Set<string> | null = null; // existing region_codes, to avoid collisions

async function loadZoneCaches(): Promise<void> {
  if (zoneCodeCache) return;

  const rows = await prisma.zone.findMany({
    select: { id: true, region_name: true, region_code: true },
  });

  zoneCodeCache = new Set(rows.map((row) => row.region_code));
  for (const row of rows) {
    zoneNameKeyCache.set(normalizeKey(row.region_name), row.id);
  }
}

/**
 * Derives a short, unique region_code candidate from the zone's name (first
 * three letters, uppercased), appending a numeric suffix on collision —
 * same spirit as seed.ts's `name.slice(0, 3).toUpperCase()` department
 * codes, just collision-safe since these are created ad hoc at import time
 * rather than seeded from a known, non-overlapping list.
 */
function generateZoneCode(rawName: string): string {
  const letters = cleanDisplayValue(rawName)
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  const base = (letters || "ZN").slice(0, 3).padEnd(3, "X");

  let candidate = base;
  let suffix = 1;
  while (zoneCodeCache!.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Returns the id of the Zone row matching `rawName` (by normalized
 * region_name), creating one — with a freshly generated region_code — if
 * this is the first time this value has been seen.
 */
export async function resolveOrCreateZoneByName(
  rawName: string,
): Promise<string> {
  await loadZoneCaches();

  const key = normalizeKey(rawName);
  const existingId = zoneNameKeyCache.get(key);
  if (existingId) return existingId;

  const region_code = generateZoneCode(rawName);
  const created = await prisma.zone.create({
    data: { region_code, region_name: cleanDisplayValue(rawName) },
  });

  zoneNameKeyCache.set(key, created.id);
  zoneCodeCache!.add(region_code);
  return created.id;
}

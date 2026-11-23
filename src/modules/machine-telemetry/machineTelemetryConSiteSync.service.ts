// ─────────────────────────────────────────────────────────────────────────────
// Orchestrates the daily "ask ConSite for every machine's position/HMR" sync.
//
// This is the ConSite path (see machineTelemetrySync.service.ts for how it's
// combined with the C4C/InSite path). The reason for using ConSite at all:
// it returns every machine in a handful of bulk, paginated calls
// (consiteMachineInfo.service.ts) instead of one call per machine, which is
// what the C4C path still has to do — so ConSite machines are routed here
// specifically to cut outbound call volume.
//
// Flow: fetch every machine ConSite knows about → map to TelemetryRow →
// attach dailyOperationHrs via one batched previous-reading lookup →
// ensure any unknown serial numbers get a bare Machine row first (FK
// safety — ConSite can know about a pin that hasn't been imported yet) →
// batch-write into MachineTelemetry → log + return a summary.
//
// Kept the same SyncOptions/SyncSummary shape as the C4C sync deliberately,
// so machineTelemetrySync.service.ts can treat both paths interchangeably.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import {
  fetchAllConSiteMachines,
  ConSiteMachineRecord,
} from "./consiteMachineInfo.service";
import {
  computeDailyOperationHrs,
  getPreviousHmrMap,
} from "./utils/dailyOperation";
import { resolvePincodeFromBoundary } from "./utils/pincodeResolver";
import { hasValidCoordinates } from "./utils/coordinates";

const DB_WRITE_BATCH_SIZE = 500;

type TelemetryRow = {
  machineSerialNumber: string;
  latitude: number;
  longitude: number;
  hmr: number;
  dailyOperationHrs: number | null;
  pincode: string | null;
  operationDate: string | null;
  syncedAt: Date;
};

export type SyncOptions = {
  // When provided, the sync writes telemetry only for these serial numbers
  // instead of every machine ConSite returns — used for targeted test
  // runs, same meaning as it had for the old C4C sync. Note this now
  // filters ConSite's single bulk response rather than limiting which
  // machines get called, since there's no more per-machine call to skip.
  machineSerialNumber?: string[];
};

export type SyncSummary = {
  total: number;
  succeeded: number;
  failed: number;
  failedSerialNumbers: string[];
};

// ── Mapping (pure) ───────────────────────────────────────────────────────────
//
// dailyOperationHrs and pincode aren't known yet at this stage —
// dailyOperationHrs depends on each machine's previous reading (one
// batched query after every record has been mapped), and pincode is
// resolved via point-in-polygon just after. See enrichRows below.

type RawTelemetryRow = Omit<TelemetryRow, "dailyOperationHrs" | "pincode">;

function mapConSiteRecordToTelemetryRow(
  record: ConSiteMachineRecord,
  syncedAt: Date,
): RawTelemetryRow | null {
  if (!record.pin) return null;

  return {
    machineSerialNumber: record.pin,
    latitude: Number(record.lat),
    longitude: Number(record.lon),
    hmr: Number(record.operationTm) || 0,
    // Stored as-is, not parsed — see the operationDate comment on the
    // MachineTelemetry model for why. ConSite doesn't guarantee every
    // record has one, so an empty value is stored as null rather than
    // an empty string.
    operationDate: record.operationTmDate || null,
    syncedAt,
  };
}

// ── Row enrichment (dailyOperationHrs + pincode) ────────────────────────────
//
// dailyOperationHrs: one batched lookup for every machine in this run, then
// a pure per-row diff — see utils/dailyOperation.ts for why this has to
// happen before any of this run's rows are inserted.
//
// pincode: pure, synchronous, in-memory point-in-polygon against the
// boundary dataset — no DB round trip needed, so it's just folded into the
// same per-row map as the dailyOperationHrs diff.

async function enrichRows(rows: RawTelemetryRow[]): Promise<TelemetryRow[]> {
  const previousHmrBySerial = await getPreviousHmrMap(
    rows.map((row) => row.machineSerialNumber),
  );

  return rows.map((row) => ({
    ...row,
    dailyOperationHrs: computeDailyOperationHrs(
      row.hmr,
      previousHmrBySerial.get(row.machineSerialNumber) ?? null,
    ),
    pincode: resolvePincodeFromBoundary(row.latitude, row.longitude),
  }));
}

// ── Machine existence (FK safety) ───────────────────────────────────────────
//
// MachineTelemetry.machineSerialNumber is FK'd to Machine. ConSite can
// return a pin that hasn't been imported into Machine yet (e.g. a newly
// delivered unit) — create a bare Machine row for it first, same
// skipDuplicates-upsert pattern as scripts/importMachines.ts.

async function ensureMachinesExist(
  machineSerialNumbers: string[],
): Promise<void> {
  if (machineSerialNumbers.length === 0) return;

  const existing = await prisma.machine.findMany({
    where: { machineSerialNumber: { in: machineSerialNumbers } },
    select: { machineSerialNumber: true },
  });
  const existingSet = new Set(
    existing.map((machine) => machine.machineSerialNumber),
  );

  const missing = machineSerialNumbers.filter(
    (serialNumber) => !existingSet.has(serialNumber),
  );
  if (missing.length === 0) return;

  await prisma.machine.createMany({
    data: missing.map((machineSerialNumber) => ({ machineSerialNumber })),
    skipDuplicates: true,
  });

  logger.info(
    `[MachineTelemetrySync] Created ${missing.length} new machine(s) from ConSite data: ${missing.join(", ")}`,
  );
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function runConSiteSync(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const syncedAt = new Date(); // one timestamp for the whole run — see MachineTelemetry schema notes

  const allMachines = await fetchAllConSiteMachines();

  const requestedSet = options.machineSerialNumber
    ? new Set(options.machineSerialNumber)
    : null;

  const rawRows: RawTelemetryRow[] = [];
  const failedSerialNumbers: string[] = [];

  for (const record of allMachines) {
    if (requestedSet && !requestedSet.has(record.pin)) continue;

    const row = mapConSiteRecordToTelemetryRow(record, syncedAt);
    if (!row) {
      failedSerialNumbers.push(record.pin ?? record.serialNo ?? "unknown");
      continue;
    }

    // Checked here, not left for enrichRows to discover — a NaN here
    // would otherwise throw out of enrichRows' single batch .map() and
    // take every other machine's already-mapped data down with it, same
    // failure mode as the C4C path.
    if (!hasValidCoordinates(row.latitude, row.longitude)) {
      failedSerialNumbers.push(row.machineSerialNumber);
      continue;
    }

    rawRows.push(row);
  }

  // Looked up and attached BEFORE ensureMachinesExist/insert below, so this
  // run's own rows can never be mistaken for "the previous reading".
  const rows = await enrichRows(rawRows);

  await ensureMachinesExist(rows.map((row) => row.machineSerialNumber));

  for (let offset = 0; offset < rows.length; offset += DB_WRITE_BATCH_SIZE) {
    await prisma.machineTelemetry.createMany({
      data: rows.slice(offset, offset + DB_WRITE_BATCH_SIZE),
    });
  }

  const total = requestedSet ? requestedSet.size : allMachines.length;

  logger.info(
    `[MachineTelemetrySync] ${rows.length}/${total} machines synced successfully from ConSite.`,
  );
  if (failedSerialNumbers.length > 0) {
    logger.error(
      `[MachineTelemetrySync] ${failedSerialNumbers.length} machine(s) failed to map: ${failedSerialNumbers.join(", ")}`,
    );
  }

  return {
    total,
    succeeded: rows.length,
    failed: failedSerialNumbers.length,
    failedSerialNumbers,
  };
}

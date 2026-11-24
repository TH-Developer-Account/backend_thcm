// ─────────────────────────────────────────────────────────────────────────────
// This is the InSite sync path now (see machineTelemetrySync.service.ts):
// one call per machine, same as always, just invoked for a smaller,
// filtered set of serial numbers.
//
// Orchestrates the daily "ask C4C for every machine's lat/long/HMR" sync.
// One call per machine (C4C has no confirmed bulk endpoint yet), with
// bounded concurrency so we never spike outbound connections or the DB.
//
// Flow: split all machine serial numbers into fixed-size batches, then for
// each batch in turn — call C4C per machine with limited concurrency and
// per-call retry → attach each row's pincode (in-memory point-in-polygon;
// dailyOperationHrs is forced to null here for now, see the TODO on
// enrichRows below) → write that batch's successes into MachineTelemetry
// before moving to the next batch → log a running total. Processing in
// batches (see FETCH_WRITE_BATCH_SIZE below) means a crash or a batch-wide
// failure only costs that batch, not the whole run, and progress is
// visible and durable as it happens rather than all-or-nothing at the end.
// This is a full daily sync, so a machine that fails today is retried
// automatically tomorrow — no same-day re-run logic, per the agreed design.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { fetchOData, unwrapODataResults } from "@shared/utils/odata";
import { mapWithConcurrency } from "./utils/concurrency";
import { withRetry } from "./utils/withRetry";
import { resolvePincodeFromBoundary } from "./utils/pincodeResolver";
import { hasValidCoordinates } from "./utils/coordinates";
import { chunk } from "./utils/chunk";

// ── Config ────────────────────────────────────────────────────────────────────

// Conservative starting point for the POC — C4C's real rate limit isn't
// confirmed yet. Raise once known; this is the only line that needs to
// change to tune outbound load.
const CONCURRENT_C4C_CALLS = 5;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// How many machines go through fetch → enrich → write as one unit before
// the next batch starts. Deliberately separate from CONCURRENT_C4C_CALLS
// (which only bounds in-flight HTTP calls within a batch): this number
// bounds how much work is lost to a crash or a batch-wide failure, and
// how long you wait before the first row lands in the DB. 500 was chosen
// as a starting point that still gives ~19 incremental writes for the
// full ~9,663-machine population instead of 1 (collect-everything) or
// ~1,900 (one per HTTP call) — revisit if that balance feels wrong once
// this runs against the real population a few times.
const FETCH_WRITE_BATCH_SIZE = 500;

const C4C_ENTITY_SET = "RPZB73EE6307DAE3DED5CAC90QueryResults";

// Trimmed to exactly what we use — CUUID to match the machine, lat/long for
// the reading. The original API doc's sample also selects customer code/
// name, location string, and product ref; we deliberately don't request
// those, since none of them are stored (confirmed out of scope) — smaller
// payload, less load, matches the "optimized" requirement.
//
// TODO: once C4C confirms the HMR field name for this entity, add it here
// and replace the `hmr: 0` fallback in mapC4CResultToTelemetryRow below —
// AND, when you do, see the matching TODO on enrichRows() further down:
// dailyOperationHrs is forced to null here specifically because this hmr
// value isn't real yet, and that override needs to come out at the same
// time or dailyOperationHrs will silently stay null forever.
const C4C_SELECT_FIELDS = [
  "CUUID",
  "Cs1ANs6B8788AE5252FD8",
  "Cs1ANs6E1FCA19B68687C",
].join(",");

type C4CTelemetryResult = {
  CUUID: string;
  Cs1ANs6B8788AE5252FD8: string; // Latitude
  Cs1ANs6E1FCA19B68687C: string; // Longitude
};

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

// dailyOperationHrs and pincode aren't known at per-machine-fetch time —
// see enrichRows below, applied once to the whole batch.
type RawTelemetryRow = Omit<TelemetryRow, "dailyOperationHrs" | "pincode">;

type FetchOutcome =
  | { status: "success"; row: RawTelemetryRow }
  | { status: "failure"; serialNumber: string; reason: string };

export type SyncSummary = {
  total: number;
  succeeded: number;
  failed: number;
  failedSerialNumbers: string[];
};

// ── C4C call (one machine) ───────────────────────────────────────────────────

function buildODataUrl(serialNumber: string): string {
  const baseUrl = process.env.C4C_ODATA_BASE_URL;
  if (!baseUrl) {
    throw new Error("C4C_ODATA_BASE_URL must be configured");
  }

  // OData string literals escape a single quote by doubling it — matters
  // here even though real serial numbers are alphanumeric, since a bad
  // escape would silently return the wrong machine's data, not an error.
  const escapedSerialNumber = serialNumber.replace(/'/g, "''");

  return (
    `${baseUrl}/${C4C_ENTITY_SET}` +
    `?$select=${C4C_SELECT_FIELDS}` +
    `&$filter=(CUUID eq '${escapedSerialNumber}')` +
    `&$format=json`
  );
}

async function fetchC4CTelemetry(
  serialNumber: string,
): Promise<C4CTelemetryResult | null> {
  const url = buildODataUrl(serialNumber);
  const data = await fetchOData(url, "C4C"); // reads C4C_USERNAME / C4C_PASSWORD from env
  const results = unwrapODataResults(data) as C4CTelemetryResult[] | undefined;

  return results && results.length > 0 ? results[0] : null;
}

// ── Mapping (pure) ───────────────────────────────────────────────────────────

function mapC4CResultToTelemetryRow(
  machineSerialNumber: string,
  result: C4CTelemetryResult,
  syncedAt: Date,
): RawTelemetryRow {
  return {
    machineSerialNumber,
    latitude: Number(result.Cs1ANs6B8788AE5252FD8),
    longitude: Number(result.Cs1ANs6E1FCA19B68687C),
    hmr: 0, // TODO: see C4C_SELECT_FIELDS comment above
    operationDate: null, // C4C/InSite has no equivalent field — ConSite-only
    syncedAt,
  };
}

// ── Row enrichment (dailyOperationHrs + pincode) ────────────────────────────
//
// pincode resolution is pure/synchronous/in-memory, same as the ConSite
// path. dailyOperationHrs is NOT computed here, unlike ConSite — see the
// TODO below.
//
// TODO: dailyOperationHrs is forced to null for every C4C row, deliberately
// NOT diffed from hmr. hmr is still a hardcoded 0 (see C4C_SELECT_FIELDS
// comment above) — diffing a fake value against yesterday's fake value
// would produce 0 - 0 = 0 every time, which reads as "this machine did
// zero hours of work today," a specific, confident, WRONG claim — not
// "we don't know yet," which null correctly conveys. Once C4C's real HMR
// field is wired up, remove this override and restore the real diff:
//   const previousHmrBySerial = await getPreviousHmrMap(
//     rows.map((row) => row.machineSerialNumber),
//   );
//   dailyOperationHrs: computeDailyOperationHrs(
//     row.hmr,
//     previousHmrBySerial.get(row.machineSerialNumber) ?? null,
//   ),
// (getPreviousHmrMap isn't called at all right now — no point paying for
// that query for a diff we're just going to discard.)

async function enrichRows(rows: RawTelemetryRow[]): Promise<TelemetryRow[]> {
  return rows.map((row) => ({
    ...row,
    dailyOperationHrs: null,
    pincode: resolvePincodeFromBoundary(row.latitude, row.longitude),
  }));
}

// ── Per-machine fetch, with retry ────────────────────────────────────────────

async function fetchOutcomeForMachine(
  serialNumber: string,
  syncedAt: Date,
): Promise<FetchOutcome> {
  try {
    const result = await withRetry(() => fetchC4CTelemetry(serialNumber), {
      attempts: RETRY_ATTEMPTS,
      delayMs: RETRY_DELAY_MS,
    });

    if (!result) {
      return {
        status: "failure",
        serialNumber,
        reason: "No record returned by C4C",
      };
    }

    const row = mapC4CResultToTelemetryRow(serialNumber, result, syncedAt);

    // Checked here, not left for enrichRows to discover — a NaN here
    // would otherwise throw out of enrichRows' single batch .map() and
    // take every other machine's already-fetched data down with it.
    if (!hasValidCoordinates(row.latitude, row.longitude)) {
      return {
        status: "failure",
        serialNumber,
        reason:
          `Invalid or missing latitude/longitude from C4C ` +
          `(lat="${result.Cs1ANs6B8788AE5252FD8}", long="${result.Cs1ANs6E1FCA19B68687C}")`,
      };
    }

    return { status: "success", row };
  } catch (error) {
    return {
      status: "failure",
      serialNumber,
      reason: (error as Error).message,
    };
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type SyncOptions = {
  machineSerialNumber?: string[];
};

// Fetches, enriches and writes one batch of serial numbers. Pulled out of
// runC4CSync so the per-batch logic (and its own success/failure split)
// isn't nested inside the batch-loop — runC4CSync just accumulates what
// this returns.
async function processBatch(
  serialNumbers: string[],
  syncedAt: Date,
): Promise<{
  succeededCount: number;
  failures: { serialNumber: string; reason: string }[];
}> {
  const outcomes = await mapWithConcurrency(
    serialNumbers,
    CONCURRENT_C4C_CALLS,
    (serialNumber) => fetchOutcomeForMachine(serialNumber, syncedAt),
  );

  const rawSucceededRows = outcomes
    .filter(
      (outcome): outcome is { status: "success"; row: RawTelemetryRow } =>
        outcome.status === "success",
    )
    .map((outcome) => outcome.row);

  const failures = outcomes.filter(
    (
      outcome,
    ): outcome is { status: "failure"; serialNumber: string; reason: string } =>
      outcome.status === "failure",
  );

  const succeededRows = await enrichRows(rawSucceededRows);

  if (succeededRows.length > 0) {
    await prisma.machineTelemetry.createMany({ data: succeededRows });
  }

  return { succeededCount: succeededRows.length, failures };
}

export async function runC4CSync(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const syncedAt = new Date(); // one timestamp for the whole run — see schema notes
  const machines = await prisma.machine.findMany({
    select: { machineSerialNumber: true },
    where: options.machineSerialNumber
      ? { machineSerialNumber: { in: options.machineSerialNumber } }
      : undefined,
  });
  const serialNumbers = machines.map((machine) => machine.machineSerialNumber);
  const batches = chunk(serialNumbers, FETCH_WRITE_BATCH_SIZE);

  let succeededCount = 0;
  const failures: { serialNumber: string; reason: string }[] = [];

  // Each batch is fetched, enriched and written to the DB before the next
  // one starts — so a crash, or a batch where every call fails, only
  // costs this batch's machines instead of the entire run's progress,
  // and rows from earlier batches are already durable in the DB.
  //
  // processBatch itself never rejects on a per-machine failure (those are
  // already isolated inside it — see fetchOutcomeForMachine). The only way
  // this call throws is a batch-wide failure: the createMany write itself
  // failing (e.g. a dropped DB connection). Postgres rolls back a failed
  // statement as a whole, so none of this batch's rows were written —
  // every machine in it is treated the same as any other per-machine
  // failure (logged, counted, retried tomorrow), and the loop moves on
  // to the next batch instead of aborting the entire run.
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    try {
      const result = await processBatch(batch, syncedAt);
      succeededCount += result.succeededCount;
      failures.push(...result.failures);

      logger.info(
        `[MachineTelemetrySync] Batch ${batchIndex + 1}/${batches.length}: ` +
          `${result.succeededCount}/${batch.length} synced ` +
          `(${succeededCount}/${serialNumbers.length} total so far).`,
      );
    } catch (error) {
      const reason = `Batch write failed: ${(error as Error).message}`;
      failures.push(...batch.map((serialNumber) => ({ serialNumber, reason })));

      logger.error(
        `[MachineTelemetrySync] Batch ${batchIndex + 1}/${batches.length} ` +
          `failed entirely (${batch.length} machine(s) — ${reason}). ` +
          `Continuing with the next batch.`,
      );
    }
  }

  if (failures.length > 0) {
    logger.error(
      `[MachineTelemetrySync] ${failures.length} machine(s) failed: ` +
        failures
          .map((failure) => `${failure.serialNumber} (${failure.reason})`)
          .join("; "),
    );
  }

  return {
    total: machines.length,
    succeeded: succeededCount,
    failed: failures.length,
    failedSerialNumbers: failures.map((failure) => failure.serialNumber),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrates the daily "ask C4C for every machine's lat/long/HMR" sync.
// One call per machine (C4C has no confirmed bulk endpoint yet), with
// bounded concurrency so we never spike outbound connections or the DB.
//
// Flow: fetch all machine serial numbers → call C4C for each, with limited
// concurrency and per-call retry → batch-write the successes into
// MachineTelemetry → log a summary. This is a full daily sync, so a machine
// that fails today is retried automatically tomorrow — no same-day re-run
// logic, per the agreed design.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { fetchOData, unwrapODataResults } from "@shared/utils/odata";
import { mapWithConcurrency } from "./utils/concurrency";
import { withRetry } from "./utils/withRetry";

// ── Config ────────────────────────────────────────────────────────────────────

// Conservative starting point for the POC — C4C's real rate limit isn't
// confirmed yet. Raise once known; this is the only line that needs to
// change to tune outbound load.
const CONCURRENT_C4C_CALLS = 5;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const DB_WRITE_BATCH_SIZE = 500;

const C4C_ENTITY_SET = "RPZB73EE6307DAE3DED5CAC90QueryResults";

// Trimmed to exactly what we use — CUUID to match the machine, lat/long for
// the reading. The original API doc's sample also selects customer code/
// name, location string, and product ref; we deliberately don't request
// those, since none of them are stored (confirmed out of scope) — smaller
// payload, less load, matches the "optimized" requirement.
//
// TODO: once C4C confirms the HMR field name for this entity, add it here
// and replace the `hmr: 0` fallback in mapC4CResultToTelemetryRow below.
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
  syncedAt: Date;
};

type FetchOutcome =
  | { status: "success"; row: TelemetryRow }
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
): TelemetryRow {
  return {
    machineSerialNumber,
    latitude: Number(result.Cs1ANs6B8788AE5252FD8),
    longitude: Number(result.Cs1ANs6E1FCA19B68687C),
    hmr: 0, // TODO: see C4C_SELECT_FIELDS comment above
    syncedAt,
  };
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

    return {
      status: "success",
      row: mapC4CResultToTelemetryRow(serialNumber, result, syncedAt),
    };
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

  const outcomes = await mapWithConcurrency(
    machines.map((machine) => machine.machineSerialNumber),
    CONCURRENT_C4C_CALLS,
    (serialNumber) => fetchOutcomeForMachine(serialNumber, syncedAt),
  );

  const succeededRows = outcomes
    .filter(
      (outcome): outcome is { status: "success"; row: TelemetryRow } =>
        outcome.status === "success",
    )
    .map((outcome) => outcome.row);

  const failures = outcomes.filter(
    (
      outcome,
    ): outcome is { status: "failure"; serialNumber: string; reason: string } =>
      outcome.status === "failure",
  );

  // DB writes are a separate pass over the already-collected results, not
  // interleaved with the C4C calls above — avoids any shared-mutable-state
  // race between concurrent fetches and a periodic flush.
  for (
    let offset = 0;
    offset < succeededRows.length;
    offset += DB_WRITE_BATCH_SIZE
  ) {
    await prisma.machineTelemetry.createMany({
      data: succeededRows.slice(offset, offset + DB_WRITE_BATCH_SIZE),
    });
  }

  logger.info(
    `[MachineTelemetrySync] ${succeededRows.length}/${machines.length} machines synced successfully.`,
  );
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
    succeeded: succeededRows.length,
    failed: failures.length,
    failedSerialNumbers: failures.map((failure) => failure.serialNumber),
  };
}

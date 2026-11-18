// ─────────────────────────────────────────────────────────────────────────────
// Combined daily telemetry sync — the single entry point the worker calls.
//
// Scope: ONLY machines flagged isKeyAccount: true (per the agreed design —
// telemetry is being rolled out to key accounts first, not the whole
// fleet). Within that set, splits by isConsiteMachine:
//   - true  → ConSite's bulk paginated fetch (machineTelemetryConSiteSync),
//             filtered down to this machine's serials via its existing
//             SyncOptions.machineSerialNumber.
//   - false/null → the original per-machine C4C fetch
//             (machineTelemetryC4CSync), same filtering mechanism — this
//             sync was NOT deleted; InSite machines still need it.
//
// Both sub-syncs write into the same MachineTelemetry table; this module
// just orchestrates which machines go to which one and merges the two
// summaries into one.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import {
  runConSiteSync,
  SyncSummary as ConSiteSyncSummary,
} from "./machineTelemetryConSiteSync.service";
import {
  runC4CSync,
  SyncSummary as C4CSyncSummary,
} from "./machineTelemetryC4CSync.service";

export type CombinedSyncSummary = {
  total: number;
  succeeded: number;
  failed: number;
  failedSerialNumbers: string[];
  consite: ConSiteSyncSummary;
  // insite: C4CSyncSummary;
};

const EMPTY_SUMMARY: ConSiteSyncSummary | C4CSyncSummary = {
  total: 0,
  succeeded: 0,
  failed: 0,
  failedSerialNumbers: [],
};

export type SyncOptions = {
  // When provided, restricts the overall isKeyAccount query BEFORE the
  // ConSite/InSite split — narrows both paths together. Used for targeted
  // test runs, same meaning it had on the old single-source syncs. Still
  // scoped to isKeyAccount: true underneath; this narrows that set
  // further, it doesn't bypass it. The daily 1am job always calls this
  // with {} (no restriction), so production behavior is unaffected by
  // this option existing.
  machineSerialNumber?: string[];
};

export async function runMachineTelemetrySync(
  options: SyncOptions = {},
): Promise<CombinedSyncSummary> {
  const keyAccountMachines = await prisma.machine.findMany({
    where: {
      isKeyAccount: true,
      ...(options.machineSerialNumber && {
        machineSerialNumber: { in: options.machineSerialNumber },
      }),
    },
    select: { machineSerialNumber: true, isConsiteMachine: true },
  });

  const consiteSerialNumbers = keyAccountMachines
    .filter((machine) => machine.isConsiteMachine === true)
    .map((machine) => machine.machineSerialNumber);

  // Anything not confirmed ConSite — including isConsiteMachine: null for
  // a key-account machine that hasn't been classified yet — goes to the
  // InSite/C4C path. Run scripts/classifyMachineTelematicsSource.ts to
  // clear any remaining nulls; this is just the safe default in the
  // meantime, not silent data loss either way (every key-account machine
  // lands in exactly one of the two groups).
  const insiteSerialNumbers = keyAccountMachines
    .filter((machine) => machine.isConsiteMachine !== true)
    .map((machine) => machine.machineSerialNumber);

  logger.info(
    `[MachineTelemetrySync] ${keyAccountMachines.length} key-account machine(s): ${consiteSerialNumbers.length} ConSite, ${insiteSerialNumbers.length} InSite.`,
  );

  const [consite] = await Promise.all([
    consiteSerialNumbers.length > 0
      ? runConSiteSync({ machineSerialNumber: consiteSerialNumbers })
      : Promise.resolve(EMPTY_SUMMARY as ConSiteSyncSummary),
    // insiteSerialNumbers.length > 0
    //   ? runC4CSync({ machineSerialNumber: insiteSerialNumbers })
    //   : Promise.resolve(EMPTY_SUMMARY as C4CSyncSummary),
  ]);

  const combined: CombinedSyncSummary = {
    total: consite.total,
    succeeded: consite.succeeded,
    failed: consite.failed,
    failedSerialNumbers: [...consite.failedSerialNumbers],
    consite,
    // insite,
  };

  logger.info(
    `[MachineTelemetrySync] Combined: ${combined.succeeded}/${combined.total} synced ` +
      `(ConSite ${consite.succeeded}/${consite.total}.`,
  );

  return combined;
}

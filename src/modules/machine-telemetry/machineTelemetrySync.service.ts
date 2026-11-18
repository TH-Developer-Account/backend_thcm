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
  insite: C4CSyncSummary;
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

  // allSettled, not all — deliberately. With Promise.all, one side throwing
  // would make us stop awaiting the other immediately, but NOT stop the
  // other's actual execution: it keeps running in the background
  // (unawaited, unobserved, its eventual result or error simply discarded),
  // since JS promises aren't cancellable. That's a real incident we hit —
  // ConSite threw fast, InSite's thousands of in-flight C4C calls kept
  // going with nobody watching, and the job was already reported "failed"
  // before InSite even finished. allSettled waits for both no matter what,
  // so we always see both outcomes and never orphan one mid-flight.
  const [consiteResult, insiteResult] = await Promise.allSettled([
    consiteSerialNumbers.length > 0
      ? runConSiteSync({ machineSerialNumber: consiteSerialNumbers })
      : Promise.resolve(EMPTY_SUMMARY as ConSiteSyncSummary),
    insiteSerialNumbers.length > 0
      ? runC4CSync({ machineSerialNumber: insiteSerialNumbers })
      : Promise.resolve(EMPTY_SUMMARY as C4CSyncSummary),
  ]);

  const consiteOutcome = resolveOutcome(consiteResult, consiteSerialNumbers);
  const insiteOutcome = resolveOutcome(insiteResult, insiteSerialNumbers);

  const consite = consiteOutcome.summary;
  const insite = insiteOutcome.summary;

  const combined: CombinedSyncSummary = {
    total: consite.total + insite.total,
    succeeded: consite.succeeded + insite.succeeded,
    failed: consite.failed + insite.failed,
    failedSerialNumbers: [
      ...consite.failedSerialNumbers,
      ...insite.failedSerialNumbers,
    ],
    consite,
    insite,
  };

  // Logged unconditionally, before any throw below — so the side that DID
  // succeed is never lost from the logs just because the other one threw.
  logger.info(
    `[MachineTelemetrySync] Combined: ${combined.succeeded}/${combined.total} synced ` +
      `(ConSite ${consite.succeeded}/${consite.total}, InSite ${insite.succeeded}/${insite.total}).`,
  );

  if (consiteOutcome.error) {
    logger.error(
      `[MachineTelemetrySync] ConSite sync threw an unhandled error: ${consiteOutcome.error.message}`,
    );
  }
  if (insiteOutcome.error) {
    logger.error(
      `[MachineTelemetrySync] InSite sync threw an unhandled error: ${insiteOutcome.error.message}`,
    );
  }

  // Still fail the BullMQ job when a side threw (same alerting/retry-window
  // visibility as before — this job stays in the failed-job list), but only
  // now that BOTH sides have actually finished and the combined summary
  // above has already been logged in full either way.
  if (consiteOutcome.error || insiteOutcome.error) {
    const failedSides = [
      consiteOutcome.error && "ConSite",
      insiteOutcome.error && "InSite",
    ]
      .filter(Boolean)
      .join(" and ");

    throw new Error(
      `MachineTelemetrySync: ${failedSides} sync threw an unhandled error — ` +
        `see the combined summary and per-side error logged above. ` +
        `ConSite error: ${consiteOutcome.error?.message ?? "none"}; ` +
        `InSite error: ${insiteOutcome.error?.message ?? "none"}`,
    );
  }

  return combined;
}

// ── allSettled → outcome (pure) ─────────────────────────────────────────────
//
// A rejected side gets a synthesized "fully failed" summary rather than
// just being dropped — so combined totals always add up to the full
// machine count regardless of which side (if any) threw, and the caller
// still gets the error itself to log/decide what to do with.

type SyncOutcome<T extends ConSiteSyncSummary | C4CSyncSummary> = {
  summary: T;
  error: Error | null;
};

function resolveOutcome<T extends ConSiteSyncSummary | C4CSyncSummary>(
  result: PromiseSettledResult<T>,
  serialNumbers: string[],
): SyncOutcome<T> {
  if (result.status === "fulfilled") {
    return { summary: result.value, error: null };
  }

  const error =
    result.reason instanceof Error
      ? result.reason
      : new Error(String(result.reason));

  return {
    summary: {
      total: serialNumbers.length,
      succeeded: 0,
      failed: serialNumbers.length,
      failedSerialNumbers: serialNumbers,
    } as T,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared by both sync paths (ConSite and C4C/InSite): the API only ever
// gives us a machine's CUMULATIVE hour-meter reading (hmr) as of today —
// never yesterday's value. But MachineTelemetry is append-only, one row
// per machine per daily sync run, so "yesterday's reading" is simply the
// most recent row already stored for that machine before this run.
// dailyOperationHrs is the delta between today's cumulative reading and
// that previous one — i.e. the machine's actual hours of operation today.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@shared/config/prisma";

// ── Pure delta calculation ───────────────────────────────────────────────────
//
// Returns null (rather than guessing) when:
//   - there's no previous reading at all (machine's first-ever sync), or
//   - today's reading is LESS than the previous one — a decreasing
//     cumulative HMR means the meter was reset, the serial number was
//     reassigned to a different physical machine, or the reading is bad.

export function computeDailyOperationHrs(
  currentHmr: number,
  previousHmr: number | null,
): number | null {
  if (previousHmr === null) return null;

  const delta = currentHmr - previousHmr;
  return delta >= 0 ? delta : null;
}

// ── Batched "previous reading per machine" lookup ───────────────────────────
//
// One query for the whole sync run, not one query per machine — same
// batching discipline as the rest of this migration. Must be called BEFORE
// this run's rows are inserted: every row in a single run shares the exact
// same syncedAt, so looking this up mid-run (after some of this run's own
// rows are already written) risks a row diffing against itself instead of
// against the prior day.
//
// Uses Postgres DISTINCT ON (via Prisma's `distinct`) against the existing
// [machineSerialNumber, syncedAt] index — cheap, no extra index needed.

export async function getPreviousHmrMap(
  machineSerialNumbers: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (machineSerialNumbers.length === 0) return map;

  const latestRows = await prisma.machineTelemetry.findMany({
    where: { machineSerialNumber: { in: machineSerialNumbers } },
    orderBy: [{ machineSerialNumber: "asc" }, { syncedAt: "desc" }],
    distinct: ["machineSerialNumber"],
    select: { machineSerialNumber: true, hmr: true },
  });

  for (const row of latestRows) {
    map.set(row.machineSerialNumber, Number(row.hmr));
  }

  return map;
}

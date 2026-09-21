// kernel/jobs/batchRunner.ts
//
// Generic fan-out/tally skeleton for scheduled batch jobs — "create one X
// per qualifying Y, on a schedule." Extracted because Dealer Audit and
// (eventually) Factory Audit both need the same loop shape: resolve a
// population, create-or-skip per item, never let one item's failure abort
// the rest, and report a summary — around entirely different population
// queries and creation logic. Only the mechanics are shared here; each
// caller still owns what "the item" is, what counts as a duplicate, and
// what "create" does.

export type BatchRunSummary = {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  failures: { key: string; reason: string }[];
};

export async function runBatchJob<T>(
  items: T[],
  keyOf: (item: T) => string,
  run: (item: T) => Promise<"created" | "skipped">,
): Promise<BatchRunSummary> {
  const summary: BatchRunSummary = {
    attempted: items.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  for (const item of items) {
    try {
      const outcome = await run(item);
      if (outcome === "created") {
        summary.succeeded++;
      } else {
        summary.skipped++;
      }
    } catch (err) {
      summary.failed++;
      summary.failures.push({
        key: keyOf(item),
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return summary;
}

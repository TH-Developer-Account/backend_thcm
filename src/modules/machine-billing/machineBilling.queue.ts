import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

export const MACHINE_BILLING_SYNC_QUEUE_NAME = "machine-billing-sync";
export const MACHINE_BILLING_SYNC_JOB_NAME = "daily-sync";

// Lookback window for the recurring job -- wider than 1 day so a document
// posted a few days late still gets picked up on a later run. Idempotent
// either way: re-fetching an already-synced day and taking "latest wins"
// again just re-writes the same values.
const DAILY_SYNC_LOOKBACK_DAYS = 7;

export type MachineBillingSyncJobData = {
  dateFrom?: string; // "YYYY-MM-DD" -- omitted on the daily schedule, which computes its own window
  dateTo?: string;
};

export const machineBillingSyncQueue = new Queue<MachineBillingSyncJobData>(
  MACHINE_BILLING_SYNC_QUEUE_NAME,
  {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 1, // a failed run is retried tomorrow by the next scheduled fire, same as machine-telemetry-sync
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  },
);

// Call once at process startup (worker.ts) -- BullMQ de-duplicates
// repeatable jobs by their repeat options, so calling again on restart
// never creates a duplicate schedule.
export async function registerMachineBillingSyncSchedule(): Promise<void> {
  await machineBillingSyncQueue.add(
    MACHINE_BILLING_SYNC_JOB_NAME,
    {},
    { repeat: { pattern: "0 2 * * *" } }, // 2am -- after the 1am telemetry sync, so they don't both hit SAP/DB at once
  );
}

export function computeDailyLookbackWindow(): {
  dateFrom: string;
  dateTo: string;
} {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - DAILY_SYNC_LOOKBACK_DAYS);

  const toISODate = (date: Date) => date.toISOString().slice(0, 10);
  return { dateFrom: toISODate(from), dateTo: toISODate(today) };
}

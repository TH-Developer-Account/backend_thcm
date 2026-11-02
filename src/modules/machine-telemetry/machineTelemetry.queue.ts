// Queue for the daily C4C telemetry sync. Same Queue/Worker split as every
// other BullMQ job in this codebase (mail, exports, notifications) — the
// one difference is this job is cron-scheduled (repeat), not
// controller-triggered.

import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

export const MACHINE_TELEMETRY_SYNC_QUEUE_NAME = "machine-telemetry-sync";
export const MACHINE_TELEMETRY_SYNC_JOB_NAME = "daily-sync";

export type MachineTelemetrySyncJobData = {
  // When provided, the sync runs only against these serial numbers instead
  // of every machine — used for targeted test runs. The daily 1am job
  // always enqueues {} (no machineSerialNumbers), so production behavior
  // is unaffected by this option existing.
  machineSerialNumbers?: string[];
};

export const machineTelemetrySyncQueue = new Queue<MachineTelemetrySyncJobData>(
  MACHINE_TELEMETRY_SYNC_QUEUE_NAME,
  {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      // The job itself isn't retried — runC4CSync already retries each
      // machine individually, and a full re-run tomorrow is the correct
      // behavior for anything that still fails (per the agreed design).
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days of run history
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    },
  },
);

// Registers the 1am-daily repeat rule. Call this ONCE at process startup
// (e.g. from worker.ts) — BullMQ de-duplicates repeatable jobs by their
// repeat options, so calling this again on every restart does not create
// duplicate schedules.
export async function registerMachineTelemetrySyncSchedule(): Promise<void> {
  await machineTelemetrySyncQueue.add(
    MACHINE_TELEMETRY_SYNC_JOB_NAME,
    {},
    { repeat: { pattern: "0 1 * * *" } },
  );
}

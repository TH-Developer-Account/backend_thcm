import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// queues/index.ts
//
// All BullMQ Queue instances live here.
// Controllers enqueue jobs via these instances.
// Workers consume from the same queue names.
//
// WHY separate queues (not one queue with a type field):
//   - Independent concurrency settings per job type
//   - Independent retry policies (import failures ≠ export failures)
//   - Easier to monitor and drain specific queues in production
// ─────────────────────────────────────────────────────────────────────────────

export type EpcExportJobData = {
  filters: {
    status?: string;
    departmentId?: string;
    startDate?: string; // ISO string
    endDate?: string; // ISO string
  };
  format: "csv" | "xlsx";
  requestedBy: string;
  logId: string; // ImportExportLog record ID
};

// ── Queue instances ───────────────────────────────────────────────────────────

export const epcExportQueue = new Queue<EpcExportJobData>("epc-export", {
  connection: redisConnectionQueue,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

import { Queue } from "bullmq";
import { redisConnectionQueue } from "../config/redis";

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

export type LeadImportJobData = {
  epcId: string;
  fileS3Key: string; // S3 key of uploaded CSV/XLSX
  fileMimeType: string;
  requestedBy: string; // userId who triggered import
};

export type LeadExportJobData = {
  epcId?: string; // undefined = export all leads (admin)
  format: "csv" | "xlsx";
  requestedBy: string;
};

// ── Queue instances ───────────────────────────────────────────────────────────

export const leadImportQueue = new Queue<LeadImportJobData>("lead-import", {
  connection: redisConnectionQueue,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 }, // keep 24h
    removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep 7d for debugging
  },
});

export const leadExportQueue = new Queue<LeadExportJobData>("lead-export", {
  connection: redisConnectionQueue,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

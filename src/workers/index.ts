import { Worker, Job } from "bullmq";
import { redisConnectionQueue } from "../config/redis";
import { LeadImportJobData, LeadExportJobData } from "../queues/lead.queue";
import { EpcExportJobData } from "../queues/epc.queue";
import { importLeadsFromS3 } from "../services/leadImport.services";
import { exportLeadsToBuffer } from "../services/leadExport.services";
import { exportEpcsToS3 } from "../services/epcExport.services";
import {
  uploadBufferToS3,
  getSignedReportUrl,
} from "../services/aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────────
// workers/index.ts — BullMQ worker definitions
//
// Each worker runs in the separate worker.ts process (no Express server).
// Workers share the same Redis connection and Prisma client as the API,
// but run in an isolated OS process so a long-running export job cannot
// block the API event loop or be killed by an API deploy.
//
// Job progress shape (stored in BullMQ job data, polled by the API):
//   Import: { totalRows, processedRows, failedRows, errors[] }
//   Export: { totalRows, downloadUrl }
//
// WHY store result in job.updateProgress() and not a separate DB table:
//   BullMQ already provides job state persistence in Redis. Adding a DB table
//   for job status would be redundant infrastructure. The API polls BullMQ
//   directly via getJob() — no extra table needed.
// ─────────────────────────────────────────────────────────────────────────────

// ── Lead Import Worker ────────────────────────────────────────────────────────

export function startLeadImportWorker() {
  const worker = new Worker<LeadImportJobData>(
    "lead-import",
    async (job: Job<LeadImportJobData>) => {
      const { epcId, fileS3Key, fileMimeType } = job.data;

      await job.updateProgress({ status: "parsing", processedRows: 0 });

      const result = await importLeadsFromS3(epcId, fileS3Key, fileMimeType);

      // Store full result as progress so the polling endpoint can return it
      await job.updateProgress({
        totalRows: result.totalRows,
        processedRows: result.processedRows,
        failedRows: result.failedRows,
        errors: result.errors,
      });

      return result;
    },
    {
      connection: redisConnectionQueue,
      concurrency: 3, // process up to 3 import jobs simultaneously
    },
  );

  worker.on("completed", (job) => {
    console.info(`[lead-import] Job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[lead-import] Job ${job?.id} failed:`, error.message);
  });

  return worker;
}

// ── Lead Export Worker ────────────────────────────────────────────────────────

export function startLeadExportWorker() {
  const worker = new Worker<LeadExportJobData>(
    "lead-export",
    async (job: Job<LeadExportJobData>) => {
      const { epcId, format } = job.data;

      await job.updateProgress({ status: "generating" });

      const { buffer, filename } = await exportLeadsToBuffer({ epcId, format });

      const s3Key = `exports/leads/${filename}`;
      await uploadBufferToS3(s3Key, buffer, filename);

      const downloadUrl = await getSignedReportUrl(s3Key);

      await job.updateProgress({ status: "completed", downloadUrl });

      return { s3Key, downloadUrl };
    },
    {
      connection: redisConnectionQueue,
      concurrency: 2,
    },
  );

  worker.on("completed", (job) => {
    console.info(`[lead-export] Job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[lead-export] Job ${job?.id} failed:`, error.message);
  });

  return worker;
}

// ── EPC Export Worker ─────────────────────────────────────────────────────────
// Concurrency is 1 — EPC dumps are heavy (cursor-batched DB reads + S3 upload).
// Running two simultaneously would double DB load for a low-frequency operation.

export function startEpcExportWorker() {
  const worker = new Worker<EpcExportJobData>(
    "epc-export",
    async (job: Job<EpcExportJobData>) => {
      const { filters, format } = job.data;

      await job.updateProgress({ status: "exporting", processedEpcs: 0 });

      const result = await exportEpcsToS3(
        filters,
        format,
        async (processedEpcs) => {
          await job.updateProgress({ status: "exporting", processedEpcs });
        },
      );

      const downloadUrl = await getSignedReportUrl(result.s3Key);

      await job.updateProgress({
        status: "completed",
        totalEpcs: result.totalEpcs,
        downloadUrl,
      });

      return { ...result, downloadUrl };
    },
    {
      connection: redisConnectionQueue,
      concurrency: 1,
    },
  );

  worker.on("completed", (job) => {
    console.info(
      `[epc-export] Job ${job.id} completed — ${job.returnvalue?.totalEpcs} EPCs`,
    );
  });

  worker.on("failed", (job, error) => {
    console.error(`[epc-export] Job ${job?.id} failed:`, error.message);
  });

  return worker;
}

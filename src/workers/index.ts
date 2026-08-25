import { Worker, Job } from "bullmq";

import { redisConnectionQueue } from "@shared/config/redis";
import {
  uploadBufferToS3,
  getSignedReportUrl,
} from "@shared/utils/aws-s3.services";

import { deliverNotification } from "@notifications/notification.services";
import { NotificationDeliveryJobData } from "@notifications/notification.queue";
import {
  markLogProcessing,
  markLogCompleted,
  markLogFailed,
} from "@import-export/importExportLog.services";
import { buildAndUploadErrorExcel } from "@import-export/utils/errorExcelBuilder";
import { notify } from "@notifications/notification.services";

import { LeadImportJobData, LeadExportJobData } from "@leads/lead.queue";
import { importLeadsFromS3 } from "@leads/leadImport.services";
import { exportLeadsToBuffer } from "@leads/leadExport.services";
import { EpcExportJobData } from "@map/epc.queue";
import { exportEpcsToS3 } from "@map/epcExport.services";
import { exportVendorOnboardingsToS3 } from "@vendor-onboarding/vendorOnboardingExport.service";
import { VendorOnboardingExportJobData } from "@vendor-onboarding/vendorOnboardingExport.queue";

// ─────────────────────────────────────────────────────────────────────────────
// workers/index.ts — BullMQ worker definitions
//
// Each worker runs in the separate worker process (start.worker.ts).
// Workers update the ImportExportLog at each lifecycle stage:
//   PENDING     → set by controller on enqueue
//   PROCESSING  → set here when the worker picks up the job
//   COMPLETED   → set here with stats and S3 keys after success
//   FAILED      → set here with the error message on unrecoverable failure
//
// WHY also keep job.updateProgress():
//   The polling endpoint (/import/:jobId, /export/:jobId) reads BullMQ job
//   progress directly for real-time feedback during processing. The DB log
//   is for persistent history; job progress is for live polling.
// ─────────────────────────────────────────────────────────────────────────────

// ── Lead Import Worker ────────────────────────────────────────────────────────

export function startLeadImportWorker() {
  const worker = new Worker<LeadImportJobData>(
    "lead-import",
    async (job: Job<LeadImportJobData>) => {
      const { epcId, fileS3Key, fileMimeType, logId } = job.data;

      await markLogProcessing(logId);
      await job.updateProgress({ status: "parsing", processedRows: 0 });

      const result = await importLeadsFromS3(epcId, fileS3Key, fileMimeType);

      // Build and upload error Excel if any rows failed
      let errorFileS3Key: string | null = null;
      if (result.failedRows > 0) {
        errorFileS3Key = await buildAndUploadErrorExcel({
          epcId,
          logId,
          allRawRows: result.allRawRows,
          errors: result.errors,
        });
      }

      await markLogCompleted(logId, {
        totalRecords: result.totalRows,
        successRecords: result.processedRows,
        failedRecords: result.failedRows,
        errorFileS3Key: errorFileS3Key ?? undefined,
      });

      // Keep BullMQ progress updated for real-time polling endpoint
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
      concurrency: 3,
    },
  );

  worker.on("completed", (job) => {
    console.info(`[lead-import] Job ${job.id} completed`);
  });

  worker.on("failed", async (job, error) => {
    console.error(`[lead-import] Job ${job?.id} failed:`, error.message);
    if (job?.data?.logId) {
      await markLogFailed(job.data.logId, error.message).catch((logError) =>
        console.error(
          "[lead-import] Failed to update log on failure:",
          logError,
        ),
      );
    }
  });

  return worker;
}

// ── Lead Export Worker ────────────────────────────────────────────────────────

export function startLeadExportWorker() {
  const worker = new Worker<LeadExportJobData>(
    "lead-export",
    async (job: Job<LeadExportJobData>) => {
      const { epcId, format, logId } = job.data;

      await markLogProcessing(logId);
      await job.updateProgress({ status: "generating" });

      const { buffer, filename } = await exportLeadsToBuffer({ epcId, format });

      const s3Key = `exports/leads/${filename}`;
      await uploadBufferToS3(s3Key, buffer, filename);

      // Count the records that were exported
      // exportLeadsToBuffer returns a buffer; derive count from the service result.
      // WHY we don't return count from exportLeadsToBuffer directly:
      //   The service currently returns only buffer+filename. We track record count
      //   by extending the return type below — see self-review note.
      const downloadUrl = await getSignedReportUrl(s3Key);

      await markLogCompleted(logId, {
        // totalRecords for exports = number of rows written (no failures possible)
        // TODO: exportLeadsToBuffer should return rowCount — currently we pass 0
        // as a placeholder. Tracked as a follow-up: extend LeadExportResult type.
        totalRecords: 0,
        successRecords: 0,
        failedRecords: 0,
        fileS3Key: s3Key,
      });

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

  worker.on("failed", async (job, error) => {
    console.error(`[lead-export] Job ${job?.id} failed:`, error.message);
    if (job?.data?.logId) {
      await markLogFailed(job.data.logId, error.message).catch((logError) =>
        console.error(
          "[lead-export] Failed to update log on failure:",
          logError,
        ),
      );
    }
  });

  return worker;
}

// ── EPC Export Worker ─────────────────────────────────────────────────────────
// Concurrency is 1 — EPC dumps are heavy (cursor-batched DB reads + S3 upload).

export function startEpcExportWorker() {
  const worker = new Worker<EpcExportJobData>(
    "epc-export",
    async (job: Job<EpcExportJobData>) => {
      const { filters, format, logId } = job.data;

      await markLogProcessing(logId);
      await job.updateProgress({ status: "exporting", processedEpcs: 0 });

      const result = await exportEpcsToS3(
        filters,
        format,
        async (processedEpcs) => {
          await job.updateProgress({ status: "exporting", processedEpcs });
        },
      );

      const downloadUrl = await getSignedReportUrl(result.s3Key);

      await markLogCompleted(logId, {
        totalRecords: result.totalEpcs,
        successRecords: result.totalEpcs,
        failedRecords: 0, // EPC export is all-or-nothing; no per-row failures
        fileS3Key: result.s3Key,
      });

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

  worker.on("failed", async (job, error) => {
    console.error(`[epc-export] Job ${job?.id} failed:`, error.message);
    if (job?.data?.logId) {
      await markLogFailed(job.data.logId, error.message).catch((logError) =>
        console.error(
          "[epc-export] Failed to update log on failure:",
          logError,
        ),
      );
    }
  });

  return worker;
}

// ── Notification Delivery Worker ──────────────────────────────────────────────
// Concurrency 5 — each job is lightweight (a few HTTP calls to push services
// + one Redis publish), no heavy DB/S3 work like the export workers above.

export function startNotificationDeliveryWorker() {
  const worker = new Worker<NotificationDeliveryJobData>(
    "notification-delivery",
    async (job: Job<NotificationDeliveryJobData>) => {
      await deliverNotification(job.data.notificationId);
    },
    {
      connection: redisConnectionQueue,
      concurrency: 5,
    },
  );

  worker.on("completed", (job) => {
    console.info(`[notification-delivery] Job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `[notification-delivery] Job ${job?.id} failed:`,
      error.message,
    );
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// vendorOnboardingExport.worker.ts
//
// NOTE: I don't have your actual epcExport.worker.ts / leadExport.worker.ts
// in front of me (they weren't in the project files provided), so this is
// inferred from the queue/service/ImportExportLog contracts I can see —
// same PENDING → PROCESSING → COMPLETED/FAILED lifecycle, same
// job.updateProgress()/downloadUrl shape the poll endpoint reads
// (getLeadExportStatus reads progress.downloadUrl and job.failedReason).
// Please diff this against your real worker file's setup (concurrency,
// event listeners, error formatting) before wiring it in — don't assume
// this matches exactly.
// ─────────────────────────────────────────────────────────────────────────────

export function startVendorOnboardingExportWorker() {
  const worker = new Worker<VendorOnboardingExportJobData>(
    "vendor-onboarding-export",
    async (job) => {
      const { logId, format, ...filters } = job.data;

      await markLogProcessing(logId);

      try {
        const result = await exportVendorOnboardingsToS3(filters, format);

        await markLogCompleted(logId, {
          totalRecords: result.totalRecords,
          successRecords: result.totalRecords,
          failedRecords: 0,
          fileS3Key: result.s3Key,
        });

        // Notification carries logId only, not a presigned URL — the URL
        // is generated fresh when the user actually clicks download (see
        // getOutputFileUrl), same reasoning as the poll endpoint's downloadUrl
        // staleness note above but permanent here since there's no expiry
        // window to outlive.
        await notify({
          workspaceId: job.data.workspaceId,
          recipientId: job.data.userId,
          type: "REPORT_STATUS",
          title: "Vendor onboarding export ready",
          body: `Your export of ${result.totalRecords} record${result.totalRecords === 1 ? "" : "s"} is ready to download.`,
          metadata: { downloadable: true, logId },
        });

        const downloadUrl = await getSignedReportUrl(result.s3Key);
        await job.updateProgress({ downloadUrl });

        return result;
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Unknown export failure";
        await markLogFailed(logId, reason);
        throw error;
      }
    },
    { connection: redisConnectionQueue, concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[VendorOnboardingExportWorker] Job ${job?.id} failed: ${err.message}`,
    );
  });

  return worker;
}

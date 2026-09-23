import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// mediclaimImport.queue.ts
//
// Bulk-initiates medical claims from an uploaded Excel/CSV file — one row
// per ex-employee. Each row runs the same logic as initiateMedicalClaim
// (single-claim initiation): create the claim, issue an access token, log
// the activity, and email the claim-form link. No Guest/credentials are
// created here — that still only happens when the ex-employee submits the
// form, same as the single-initiate flow.
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalClaimImportJobData = {
  workspaceId: string;
  fileS3Key: string; // S3 key of uploaded CSV/XLSX
  fileMimeType: string;
  requestedBy: string; // userId who triggered the import
  logId: string; // ImportExportLog record ID
};

export const mediclaimImportQueue = new Queue<MedicalClaimImportJobData>(
  "medical-claim-import",
  {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 60 * 60 * 24 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  },
);

import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";
import { VendorListingTab } from "./vendorOnboarding.helper";

// ─────────────────────────────────────────────────────────────────────────────
// vendorOnboardingExport.queue.ts
//
// Mirrors lead.queue.ts / epc.queue.ts — a dedicated queue per export type
// for independent concurrency/retry policies and easier per-queue monitoring.
//
// WHY approvalSubjectIds is part of the payload (not re-derived in the worker):
//   pendingOnMe/approvedByMe scoping depends on live Approval rows. The
//   controller resolves that list once at enqueue time (same as the
//   synchronous list endpoint does), so the export reflects approval state
//   at the moment the user asked for it — not whatever it drifts to while
//   the job sits in the queue. A few seconds of staleness is expected and
//   acceptable for a queued export.
// ─────────────────────────────────────────────────────────────────────────────

export type VendorOnboardingExportJobData = {
  workspaceId: string;
  userId: string;
  tab: VendorListingTab;
  search: string;
  approvalSubjectIds?: string[]; // only present for pendingOnMe/approvedByMe
  format: "csv" | "xlsx";
  requestedBy: string;
  logId: string; // ImportExportLog record ID
};

export const vendorOnboardingExportQueue =
  new Queue<VendorOnboardingExportJobData>("vendor-onboarding-export", {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { age: 60 * 60 * 24 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });

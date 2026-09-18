import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";
import { MedicalClaimListingTab } from "./mediclaim.helper";

// ─────────────────────────────────────────────────────────────────────────────
// mediclaimExport.queue.ts
//
// Mirrors vendorOnboardingExport.queue.ts — bulk export of the medical claim
// listing, scoped to the same tab/search filters as listMedicalClaims.
//
// WHY approvalSubjectIds is part of the payload (not re-derived in the
// worker): same reasoning as vendor onboarding's export queue — the
// controller resolves pendingOnMe/approvedByMe scoping once at enqueue time
// so the export reflects approval state at the moment the user asked for
// it, not whatever it drifts to while the job sits in the queue.
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalClaimExportJobData = {
  workspaceId: string;
  userId: string;
  tab: MedicalClaimListingTab;
  search: string;
  approvalSubjectIds?: string[]; // only present for pendingOnMe/approvedByMe
  format: "csv" | "xlsx";
  requestedBy: string;
  logId: string; // ImportExportLog record ID
};

export const mediclaimExportQueue = new Queue<MedicalClaimExportJobData>(
  "medical-claim-export",
  {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { age: 60 * 60 * 24 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  },
);

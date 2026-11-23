import dotenv from "dotenv";
dotenv.config();

import {
  startLeadImportWorker,
  startLeadExportWorker,
  startEpcExportWorker,
  startNotificationDeliveryWorker,
  startVendorOnboardingExportWorker,
  startMedicalClaimExportWorker,
  startMedicalClaimImportWorker,
  startEventReportGenerationWorker,
  startMachineTelemetrySyncWorker,
  // startMachineBillingSyncWorker, — TEMPORARILY disabled, see note below
} from "./workers";
import { registerMachineTelemetrySyncSchedule } from "@modules/machine-telemetry/machineTelemetry.queue";
// registerMachineBillingSyncSchedule import also disabled — see note below
// import { registerMachineBillingSyncSchedule } from "@modules/machine-billing/machineBilling.queue";

// ─────────────────────────────────────────────────────────────────────────────
// worker.ts — separate process entry point
//
// Start with:  node dist/worker.js
// PM2 example: pm2 start dist/worker.js --name "map-workers"
//
// This process boots all BullMQ workers and nothing else.
// No Express server, no HTTP port.
//
// WHY dotenv.config() first:
//   Workers need REDIS_URL, DATABASE_URL, AWS_* env vars.
//   dotenv must load before any module that reads process.env at import time.
// ─────────────────────────────────────────────────────────────────────────────

console.info("[Worker] Starting workers...");

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — machine-billing sync worker is disabled below. SAP_TH_GR_BASE_URL
// currently points at th-s4-qas-ad.tatahitachi.co.in (QA), which isn't
// network-reachable from here (no VPN tunnel to that host), so every run just
// throws ENOTFOUND. Disabling the Worker — not just the schedule registration
// further down — because BullMQ's 2am repeatable job is already persisted in
// Redis and will keep firing regardless of whether registerMachineBillingSyncSchedule()
// is called again; only removing the Worker stops something from actually
// picking up and executing those jobs. Jobs will queue up unprocessed at 2am
// until this is reverted — harmless, they just sit there.
// Revert: uncomment startMachineBillingSyncWorker() below, its import above,
// and the registerMachineBillingSyncSchedule() block further down, once the
// production SAP URL is in place.
// ─────────────────────────────────────────────────────────────────────────────
const workers = [
  startLeadImportWorker(),
  startLeadExportWorker(),
  startEpcExportWorker(),
  startNotificationDeliveryWorker(),
  startVendorOnboardingExportWorker(),
  startMedicalClaimExportWorker(),
  startMedicalClaimImportWorker(),
  startEventReportGenerationWorker(),
  startMachineTelemetrySyncWorker(),
  // startMachineBillingSyncWorker(),
];

console.info(`[Worker] ${workers.length} workers running`);

// Registers the 1am-daily repeat rule for the machine telemetry sync.
// Safe to call on every worker-process start (and on every PM2 restart) —
// BullMQ de-duplicates repeatable jobs by their repeat options, so this
// never creates a duplicate schedule.
registerMachineTelemetrySyncSchedule().catch((error) => {
  console.error(
    "[Worker] Failed to register machine telemetry sync schedule:",
    error,
  );
});

// Registers the 2am-daily repeat rule for the GR + Invoice billing sync.
// Same de-duplication guarantee as above — safe on every restart.
// TEMPORARILY disabled alongside the worker above — see the note on the
// `workers` array. Not calling this again doesn't remove the schedule
// that's already registered in Redis from before; it just avoids
// re-confirming it while the worker that would consume it is also off.
// registerMachineBillingSyncSchedule().catch((error) => {
//   console.error(
//     "[Worker] Failed to register machine billing sync schedule:",
//     error,
//   );
// });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On SIGTERM/SIGINT: stop accepting new jobs, wait for active jobs to finish,
// then exit. This prevents killing a job mid-insert on a deploy.

async function shutdown(signal: string) {
  console.info(`[Worker] ${signal} received — shutting down gracefully`);

  await Promise.all(workers.map((worker) => worker.close()));

  console.info("[Worker] All workers closed. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

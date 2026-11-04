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
} from "./workers";
import {
  machineTelemetrySyncQueue,
  registerMachineTelemetrySyncSchedule,
} from "@modules/machine-telemetry/machineTelemetry.queue";

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

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — manual test run through the real queue. Comment out the
// enqueue call below (or this whole block) once testing is done; nothing
// else needs to change to go back to pure production behavior, since the
// 1am repeatable job above is untouched by this. Runs once per
// worker-process start/restart, so restarting a few times while testing
// will enqueue a few of these — harmless, but expect a few duplicate test
// rows in MachineTelemetry as a result.
// ─────────────────────────────────────────────────────────────────────────────
const TEST_MACHINE_SERIAL_NUMBERS = [
  "THEDCRL0C00003939",
  "THEDCRL0C00003942",
  "THEDCRL0C00003948",
  "THEDCRL0C00003951",
];

machineTelemetrySyncQueue
  .add("test-sync", { machineSerialNumbers: TEST_MACHINE_SERIAL_NUMBERS })
  .catch((error) => console.error("[Worker] Test sync enqueue failed:", error));

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

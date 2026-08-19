import dotenv from "dotenv";
dotenv.config();

import {
  startLeadImportWorker,
  startLeadExportWorker,
  startEpcExportWorker,
  startNotificationDeliveryWorker,
  startEventReportGenerationWorker,
} from "./workers";

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
  startEventReportGenerationWorker(),
];

console.info(`[Worker] ${workers.length} workers running`);

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

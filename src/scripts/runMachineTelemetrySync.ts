// One-off manual trigger — bypasses BullMQ/pm2 entirely, calls the sync
// function directly so you see the result (and any thrown error) right
// here in the terminal, not buried in pm2 logs.
//
// Full population — no machineSerialNumber restriction. This WILL hit
// ConSite for its full key-account set (~5,672 at last count) and C4C for
// every InSite machine (~9,663 at last count) — a real, full-scale run,
// not a scoped test. If InSite is currently failing for every machine due
// to a missing/misconfigured env var, those calls fail fast (or fail on
// the first real auth attempt) rather than adding meaningful load — but
// if ConSite is healthy, this will write real telemetry rows for the
// entire ConSite fleet. That's expected and fine; just know that's what
// this does before running it.
//
// Run with:
//   npx ts-node -r tsconfig-paths/register src/scripts/runMachineTelemetrySync.ts

import dotenv from "dotenv";
dotenv.config();

import { runMachineTelemetrySync } from "../modules/machine-telemetry/machineTelemetrySync.service";

async function main() {
  console.log(
    "Running machine telemetry sync for the full key-account population...",
  );

  try {
    const summary = await runMachineTelemetrySync({});
    console.log("\n=== Combined summary ===");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error("\n=== Sync threw ===");
    console.error(error);
  }

  process.exit(0);
}

main();

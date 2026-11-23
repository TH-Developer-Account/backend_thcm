import dotenv from "dotenv";
dotenv.config();

import {
  machineBillingSyncQueue,
  MACHINE_BILLING_SYNC_JOB_NAME,
} from "@modules/machine-billing/machineBilling.queue";

// One-off: removes the 2am repeatable schedule for machine-billing-sync
// from Redis. Needed on top of disabling the Worker in worker.ts, since
// BullMQ's repeatable-job config is stored independently of whether
// anything is consuming the queue — not calling registerMachineBillingSyncSchedule()
// again does NOT delete a schedule that was already registered.
//
// Safe to run again later: if the schedule has already been removed (or
// never existed), this just reports 0 found and exits — it doesn't error.
//
// Re-registering after this is unchanged from before: once the production
// SAP URL is in place, uncommenting registerMachineBillingSyncSchedule()
// in worker.ts and restarting re-creates the same schedule (BullMQ
// de-duplicates by repeat options, so there's no need to run anything
// here again).

async function main() {
  const repeatableJobs = await machineBillingSyncQueue.getRepeatableJobs();

  const matches = repeatableJobs.filter(
    (job) => job.name === MACHINE_BILLING_SYNC_JOB_NAME,
  );

  if (matches.length === 0) {
    console.log(
      `No repeatable schedule named "${MACHINE_BILLING_SYNC_JOB_NAME}" found on the machine-billing-sync queue. Nothing to remove.`,
    );
    process.exit(0);
  }

  console.log(`Found ${matches.length} matching schedule(s):`);
  for (const job of matches) {
    const next = job.next ? new Date(job.next).toISOString() : "unknown";
    console.log(
      `  - name="${job.name}" pattern="${job.pattern}" key="${job.key}" next=${next}`,
    );
  }

  for (const job of matches) {
    const removed = await machineBillingSyncQueue.removeRepeatableByKey(
      job.key,
    );
    console.log(
      removed
        ? `Removed schedule with key "${job.key}".`
        : `Failed to remove schedule with key "${job.key}" (already gone?).`,
    );
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to remove machine-billing-sync schedule:", error);
  process.exit(1);
});

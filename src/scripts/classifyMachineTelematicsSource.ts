// scripts/classifyMachineTelematicsSource.ts
//
// One-time (re-runnable, idempotent) pass: classifies EVERY machine in the
// Machine table as ConSite (isConsiteMachine: true) or InSite
// (isConsiteMachine: false), based purely on its serial number — see
// modules/machine-telemetry/machineTelematicsClassifier.ts for the rule.
//
// Deliberately NOT scoped to key-account machines (per the agreed design:
// classify everything now, cheap and local; isKeyAccount is what actually
// gates whether a machine's telemetry gets fetched — see
// machineTelemetrySync.service.ts).
//
// Implemented as two bulk updateMany calls (grouped by the computed
// boolean) rather than one upsert/update per machine — ~11,000+ rows,
// no reason to pay for that many round trips when the DB can do it in two
// batched passes.
//
// Run once, manually, from the repo root:
//   npx ts-node -r tsconfig-paths/register scripts/classifyMachineTelematicsSource.ts [--dry-run]
//
// Safe to re-run any time (e.g. after importing a fresh batch of
// machines) — every machine is reclassified from its current serial
// number every time this runs.

import { prisma } from "../shared/config/prisma";
import { isConsiteSerial } from "../modules/machine-telemetry/machineTelematicsClassifier";

const UPDATE_BATCH_SIZE = 2000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function classifyMachineTelematicsSource(
  dryRun: boolean,
): Promise<void> {
  const machines = await prisma.machine.findMany({
    select: { machineSerialNumber: true, isConsiteMachine: true },
  });

  const consiteSerials: string[] = [];
  const insiteSerials: string[] = [];

  for (const machine of machines) {
    const nextValue = isConsiteSerial(machine.machineSerialNumber);
    // Only touch rows whose classification is actually changing (or was
    // never set) — keeps the updateMany calls below scoped to real work.
    if (machine.isConsiteMachine === nextValue) continue;

    (nextValue ? consiteSerials : insiteSerials).push(
      machine.machineSerialNumber,
    );
  }

  console.log(
    `${machines.length} machine(s) total — ${consiteSerials.length} newly classified ConSite, ${insiteSerials.length} newly classified InSite, ${
      machines.length - consiteSerials.length - insiteSerials.length
    } unchanged.`,
  );

  if (dryRun) {
    console.log("Dry run — no Machine rows were written.");
    return;
  }

  let updatedCount = 0;

  for (const batch of chunk(consiteSerials, UPDATE_BATCH_SIZE)) {
    const result = await prisma.machine.updateMany({
      where: { machineSerialNumber: { in: batch } },
      data: { isConsiteMachine: true },
    });
    updatedCount += result.count;
  }

  for (const batch of chunk(insiteSerials, UPDATE_BATCH_SIZE)) {
    const result = await prisma.machine.updateMany({
      where: { machineSerialNumber: { in: batch } },
      data: { isConsiteMachine: false },
    });
    updatedCount += result.count;
  }

  console.log(`Classification complete: ${updatedCount} machine(s) updated.`);
}

const dryRun = process.argv.includes("--dry-run");

classifyMachineTelematicsSource(dryRun)
  .catch((error) => {
    console.error("Classification failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

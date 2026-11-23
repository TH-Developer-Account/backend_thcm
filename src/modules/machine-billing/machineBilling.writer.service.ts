import { prisma } from "@shared/config/prisma";
import { MachineBillingUpdate } from "./machineBilling.types";

const DB_WRITE_BATCH_SIZE = 200;

// Upserts one Machine row per update -- create a bare row (just the serial
// number) for a machine the feeds mention but that doesn't exist yet, same
// pattern as importMachineMaster.ts. Chunked into separate transactions
// rather than one giant one, since a full date-range pull can touch far
// more machines than the one-time Excel import did.
export async function writeMachineBillingUpdates(
  updatesByMachine: Map<string, MachineBillingUpdate>,
): Promise<{ machinesWritten: number }> {
  const entries = [...updatesByMachine.entries()];

  for (
    let offset = 0;
    offset < entries.length;
    offset += DB_WRITE_BATCH_SIZE
  ) {
    const batch = entries.slice(offset, offset + DB_WRITE_BATCH_SIZE);

    await prisma.$transaction(
      async (tx) => {
        for (const [machineSerialNumber, update] of batch) {
          await tx.machine.upsert({
            where: { machineSerialNumber },
            create: { machineSerialNumber, ...update },
            update,
          });
        }
      },
      { timeout: 120_000 },
    );
  }

  return { machinesWritten: entries.length };
}

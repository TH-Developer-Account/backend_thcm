import { prisma } from "../../shared/config/prisma";
import logger from "../../shared/utils/logger";
import {
  fetchGRItems,
  fetchByDBillingItems,
  fetchInvoiceItems,
} from "./machineBillingFetch.service";
import {
  pickLatestGRItemPerMachine,
  pickLatestByDBillingItemPerMachine,
  pickLatestInvoiceItemPerMachine,
  buildMachineUpdates,
} from "./machineBilling.mapper";
import { writeMachineBillingUpdates } from "./machineBilling.writer.service";
import { MachineBillingSyncSummary } from "./machineBilling.types";

// Orchestrates one GR+ByD+Invoice sync run for a date range: fetch all
// three feeds -> reduce each to the latest row per machine -> merge into
// one update per machine -> upsert. Callable both from the one-off
// backfill script (explicit wide range) and the daily recurring job (a
// short rolling window) -- see machineBilling.queue.ts.
export async function runMachineBillingSync(
  dateFrom: string, // "YYYY-MM-DD"
  dateTo: string,
): Promise<MachineBillingSyncSummary> {
  const [grRows, bydRows, invoiceRows] = await Promise.all([
    fetchGRItems(dateFrom, dateTo),
    fetchByDBillingItems(dateFrom, dateTo),
    fetchInvoiceItems(dateFrom, dateTo),
  ]);

  const latestGRByMachine = pickLatestGRItemPerMachine(grRows);
  const latestByDByMachine = pickLatestByDBillingItemPerMachine(bydRows);
  const latestInvoiceByMachine = pickLatestInvoiceItemPerMachine(invoiceRows);
  const updatesByMachine = buildMachineUpdates(
    latestGRByMachine,
    latestByDByMachine,
    latestInvoiceByMachine,
  );

  // Checked before writing, so the summary can report creates vs updates --
  // upsert alone doesn't tell us which happened.
  const existingSerialNumbers = new Set(
    (
      await prisma.machine.findMany({
        where: {
          machineSerialNumber: { in: [...updatesByMachine.keys()] },
        },
        select: { machineSerialNumber: true },
      })
    ).map((machine) => machine.machineSerialNumber),
  );

  const { machinesWritten } =
    await writeMachineBillingUpdates(updatesByMachine);

  const summary: MachineBillingSyncSummary = {
    dateFrom,
    dateTo,
    grRowsFetched: grRows.length,
    bydRowsFetched: bydRows.length,
    invoiceRowsFetched: invoiceRows.length,
    machinesUpdated: machinesWritten,
    machinesCreated: [...updatesByMachine.keys()].filter(
      (serial) => !existingSerialNumbers.has(serial),
    ).length,
  };

  logger.info(
    `[MachineBillingSync] ${dateFrom} -> ${dateTo}: ${JSON.stringify(summary)}`,
  );

  return summary;
}

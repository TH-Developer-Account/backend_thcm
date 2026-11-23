/**
 * scripts/backfillMachineBilling.ts
 *
 * One-off backfill of GR + ByD + Invoice data into Machine, for the agreed
 * range (Apr 1 2026 -> today) or an explicit range you pass in.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfillMachineBilling.ts --from=2026-04-01 --to=2026-11-20
 */

import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../shared/config/prisma";
import { runMachineBillingSync } from "../modules/machine-billing/machineBillingSync.service";

const DEFAULT_FROM = "2026-04-01";

function readArg(flags: string[], name: string): string | undefined {
  return flags.find((flag) => flag.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const dateFrom = readArg(flags, "from") ?? DEFAULT_FROM;
  const dateTo = readArg(flags, "to") ?? new Date().toISOString().slice(0, 10);

  console.log(`Backfilling GR + ByD + Invoice data: ${dateFrom} -> ${dateTo}`);
  const summary = await runMachineBillingSync(dateFrom, dateTo);
  console.log("Backfill summary:", summary);
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

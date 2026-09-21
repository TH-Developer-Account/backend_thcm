// jobs/scheduler.ts
import cron from "node-cron";
import { syncDailyVisitors } from "./syncVisitors";
import { prisma } from "../config/prisma";
import { generateQuarterlyDealerAuditInstances } from "@dealerAudit/dealerAudit.service";
import logger from "@shared/utils/logger";

export const startJobs = () => {
  // Run every day at 23:59
  cron.schedule("59 23 * * *", async () => {
    console.log("Running daily DAU sync job...");
    await syncDailyVisitors();
  });

  // Quarterly Dealer Audit generation — 00:30 on the 1st of Jan/Apr/Jul/Oct.
  // Delegates entirely to generateQuarterlyDealerAuditInstances (dealer
  // population + creation both live there, alongside triggerDealerAuditInstance,
  // which this reuses rather than duplicating) — this job is wiring only.
  cron.schedule("30 0 1 1,4,7,10 *", async () => {
    logger.info("Running quarterly Dealer Audit generation job...");
    await generateQuarterlyDealerAuditInstances();
  });
};

export const escalateOverdueStages = async () => {
  const overdueStages = await prisma.stageInstance.findMany({
    where: {
      status: "IN_PROGRESS",
      dueAt: { lt: new Date() },
    },
    include: {
      approvals: true,
    },
  });

  for (const stage of overdueStages) {
    const pendingApprovers = stage.approvals.filter(
      (a) => a.status === "PENDING",
    );

    // example: escalate to manager
    const managerId = "SOME_MANAGER_ID";

    for (const p of pendingApprovers) {
      await prisma.approval.update({
        where: {
          stageId_approverId: {
            stageId: stage.id,
            approverId: p.approverId,
          },
        },
        data: {
          approverId: managerId,
        },
      });
    }

    await prisma.stageInstance.update({
      where: { id: stage.id },
      data: { escalatedTo: managerId },
    });
  }
};

// jobs/scheduler.ts
import cron from "node-cron";
import { syncDailyVisitors } from "./syncVisitors";
import { prisma } from "../config/prisma";
// Adjust this path if your dealer-audit folder lives elsewhere.
import { runDealerAuditDeadlines } from "../../dealer-audit/dealerAuditDeadline.job";

export const startJobs = () => {
  // Run every day at 23:59
  cron.schedule("59 23 * * *", async () => {
    console.log("Running daily DAU sync job...");
    await syncDailyVisitors();
  });

  // Dealer audit reminders and deadline rules, 09:30 India time.
  cron.schedule(
    "30 9 * * *",
    async () => {
      try {
        await runDealerAuditDeadlines();
      } catch (error) {
        console.error("Dealer audit deadline job failed:", error);
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  // Dealer Audits are not generated automatically: an admin launches each
  // quarter's audit cycle (POST /dealer-audit/cycles).
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

// jobs/scheduler.ts
import cron from "node-cron";
import { syncDailyVisitors } from "../utils/syncVisitors";

export const startJobs = () => {
  // Run every day at 23:59
  cron.schedule("59 23 * * *", async () => {
    console.log("Running daily DAU sync job...");
    await syncDailyVisitors();
  });
};

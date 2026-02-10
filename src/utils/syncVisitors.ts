// jobs/syncVisitors.ts
import redis from "../config/redis";
import { prisma } from "../config/prisma";

const LOCK_KEY = "lock:daily_active_users_sync";

export const syncDailyVisitors = async () => {
  const today = new Date().toISOString().split("T")[0];
  const redisKey = `daily_active_users:${today}`;

  // 🔐 acquire lock
  const lock = await redis.call("SET", LOCK_KEY, "1", "NX", "EX", "60");

  if (!lock) {
    console.log("DAU sync already running, skipping...");
    return;
  }

  try {
    const count = await redis.scard(redisKey);

    await prisma.daily_visitors.upsert({
      where: { date: new Date(today) },
      update: { total_visits: count },
      create: {
        date: new Date(today),
        total_visits: count,
      },
    });

    console.log(`DAU synced for ${today}: ${count}`);
  } catch (error) {
    console.error("DAU sync failed:", error);
  } finally {
    // Optional: let lock expire naturally
    // or explicitly delete it
    await redis.del(LOCK_KEY);
  }
};

// middleware/firstAuthRequestPerDay.ts
import { Request, Response, NextFunction } from "express";
import redis from "../config/redis";

export const firstAuthRequestPerDay = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Only track authenticated users
    if (!req.user?.id) {
      return next();
    }

    const userId = String(req.user.id);
    const today = new Date().toISOString().split("T")[0];
    const key = `daily_active_users:${today}`;

    // Redis SET guarantees uniqueness
    const isFirstToday = await redis.sadd(key, userId);

    // Set expiry only once (midnight)
    if (isFirstToday === 1) {
      const now = new Date();
      const midnight = new Date();
      midnight.setHours(23, 59, 59, 999);

      const ttl = Math.floor((midnight.getTime() - now.getTime()) / 1000);

      await redis.expire(key, ttl);
    }

    next();
  } catch (err) {
    console.error("First-auth-request DAU error:", err);
    next(); // analytics must never break the app
  }
};

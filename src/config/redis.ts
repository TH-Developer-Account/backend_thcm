import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// Used by application code (dedup, token caching)
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
});

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (err) => {
  console.error("Redis error", JSON.stringify(err, null, 2));
});

// Used by BullMQ Queue and Worker — they manage their own ioredis connections
export const bullmqConnection = { url: REDIS_URL };

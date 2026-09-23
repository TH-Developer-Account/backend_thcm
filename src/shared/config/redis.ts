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

export const redisConnectionQueue = { url: REDIS_URL };

// ── SSE pub/sub instances ───────────────────────────────────────────────────
//
// Two SEPARATE connections, not a reuse of `redis` above. IORedis puts a
// connection into dedicated subscriber mode once .subscribe() is called on
// it — after that it can no longer issue normal commands (GET/SET/PUBLISH).
// So: one instance only ever publishes, one instance only ever subscribes.
//
// redisConnectionPublisher  — used by notification.worker.ts to announce
//   "this user has a new notification" after delivery.
// redisConnectionSubscriber — used once at app boot (realtime/sse.bootstrap.ts)
//   to listen for those announcements and forward to local SSE connections.

export const redisConnectionPublisher = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
});

export const redisConnectionSubscriber = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
});

redisConnectionPublisher.on("error", (err) => {
  console.error("Redis (publisher) error", JSON.stringify(err, null, 2));
});

redisConnectionSubscriber.on("error", (err) => {
  console.error("Redis (subscriber) error", JSON.stringify(err, null, 2));
});

import Redis from "ioredis";

console.log(
  "Connecting to Redis...",
  process.env.REDIS_PASSWORD,
  process.env.REDIS_PORT,
);

const redis = new Redis({
  host: "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  //   password: process.env.REDIS_PASSWORD,
});

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (err) => {
  console.error("Redis error", JSON.stringify(err, null, 2));
});

export default redis;

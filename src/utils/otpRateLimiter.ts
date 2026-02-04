import { RateLimiterRedis } from "rate-limiter-flexible";
import redis from "../config/redis";

export const otpSendLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: "otp_send",
  points: 3, // 3 OTPs
  duration: 600, // per 10 minutes
});

import redis from "../config/redis";
import { COOLDOWN_SECONDS, MAX_ATTEMPTS, WINDOW_SECONDS } from "./contants";

export const checkOtpLimit = async (mobile: string) => {
  const cooldownKey = `otp:cooldown:${mobile}`;
  const countKey = `otp:count:${mobile}`;

  // 1️⃣ Cooldown check
  const cooldownTtl = await redis.ttl(cooldownKey);
  if (cooldownTtl > 0) {
    return {
      allowed: false,
      message: `Please wait ${cooldownTtl}s before retrying`,
    };
  }

  // 2️⃣ Max attempts check
  const count = Number(await redis.get(countKey));
  if (count >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      message: "Too many OTP requests. Try again later.",
    };
  }

  return { allowed: true };
};

export const updateOtpLimit = async (mobile: string) => {
  const cooldownKey = `otp:cooldown:${mobile}`;
  const countKey = `otp:count:${mobile}`;

  await redis.set(cooldownKey, "1", "EX", COOLDOWN_SECONDS);
  await redis.multi().incr(countKey).expire(countKey, WINDOW_SECONDS).exec();
};

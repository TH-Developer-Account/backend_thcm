import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../config/prisma";
import redis from "../config/redis";
import { otpSendLimiter } from "../utils/otpRateLimiter";
import ApiError from "../utils/apiError";
import {
  SALT_ROUNDS,
  MAX_OTP_ATTEMPTS,
  LOCK_TIME_SECONDS,
  OTP_EXPIRY_MINUTES,
} from "../utils/contants";

export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { first_name, last_name, password, email, phone_number, user_type } =
      req.body;

    if (!email || !password) {
      throw new ApiError(400, "Email and password are required");
    }

    // Check if user exists
    const existingUser = await prisma.users.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ApiError(409, "User already exists");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Save user
    const user = await prisma.users.create({
      data: {
        first_name,
        last_name,
        phone_number,
        is_active: true,
        email,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        created_at: true,
      },
    });

    // 4️⃣ Respond
    res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    next(error);
  }
};

export const loginUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { password, email, phone_number } = req.body;

    if (!email || !password) {
      throw new ApiError(400, "Email and password are required");
    }

    // Check if user exists
    const existingUser = await prisma.users.findUnique({
      where: { email },
    });

    if (!existingUser) {
      throw new ApiError(409, "User does not exist, Please register");
    }

    // check password
    const isValidPassword = await bcrypt.compare(
      password,
      existingUser.password,
    );

    if (!isValidPassword) {
      throw new ApiError(401, "Invalid credentials");
    }

    // JWT logic for the user

    // Respond
    res.status(201).json({
      message: "User Logged in successfully",
      user: existingUser,
    });
  } catch (error) {
    next(error);
  }
};

export const sendOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { phone_number } = req.body;

    if (!phone_number) {
      throw new ApiError(400, "Phone number is required");
    }

    // 1️⃣ RATE LIMIT OTP REQUESTS
    try {
      await otpSendLimiter.consume(phone_number);
    } catch (rateLimitError) {
      throw new ApiError(429, "Too many OTP requests. Try again later.");
    }

    // 2️⃣ Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 3️⃣ Hash OTP
    const otpHash = await bcrypt.hash(otp, 10);

    // 4️⃣ Store OTP in DB
    await prisma.user_otps.create({
      data: {
        phone: phone_number,
        otp_hash: otpHash,
        expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
      },
    });

    // 5️⃣ Send OTP (SMS)
    console.log(`OTP for ${phone_number}: ${otp}`);

    res.status(200).json({
      message: "OTP sent successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const verifyOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { phone_number, otp } = req.body;

    // Check lock
    const isLocked = await redis.get(`otp_lock:${phone_number}`);
    if (isLocked) {
      throw new ApiError(423, "Account locked. Try again later.");
    }

    // Fetch OTP from DB
    const otpRecord = await prisma.user_otps.findFirst({
      where: {
        phone: phone_number,
        is_used: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: "desc" },
    });

    if (!otpRecord) {
      throw new ApiError(401, "Invalid or expired OTP");
    }

    // Compare OTP
    const isValid = await bcrypt.compare(otp, otpRecord.otp_hash);

    if (!isValid) {
      const attempts = await redis.incr(`otp_fail:${phone_number}`);

      if (attempts === 1) {
        await redis.expire(`otp_fail:${phone_number}`, LOCK_TIME_SECONDS);
      }

      if (attempts >= MAX_OTP_ATTEMPTS) {
        await redis.set(
          `otp_lock:${phone_number}`,
          "locked",
          "EX",
          LOCK_TIME_SECONDS,
        );
      }

      throw new ApiError(401, "Invalid OTP");
    }

    // OTP success → cleanup
    await redis.del(`otp_fail:${phone_number}`);
    await redis.del(`otp_lock:${phone_number}`);

    await prisma.user_otps.update({
      where: { id: otpRecord.id },
      data: { is_used: true },
    });

    res.json({ message: "OTP verified successfully" });
  } catch (error) {
    next(error);
  }
};

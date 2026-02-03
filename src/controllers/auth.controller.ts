import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../config/prisma";
import redis from "../config/redis";
import { otpSendLimiter } from "../utils/otpRateLimiter";
import ApiError from "../utils/apiError";
// import { sendPasswordResetEmail } from "../utils/sendEmail";
import {
  SALT_ROUNDS,
  MAX_OTP_ATTEMPTS,
  LOCK_TIME_SECONDS,
  OTP_EXPIRY_MINUTES,
} from "../utils/contants";
import { signAccessToken, createRefreshToken } from "../services/auth.services";

export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { first_name, last_name, password, email, phone_number } = req.body;

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

export const loginWithPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { password, email } = req.body;

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

    // ✅ NEW: Check if user needs to reset default password
    if (existingUser.is_default_login) {
      // Verify the default password is correct
      const isValidPassword = await bcrypt.compare(
        password,
        existingUser.password,
      );

      if (!isValidPassword) {
        throw new ApiError(401, "Invalid credentials");
      }

      // Return special response indicating password reset required
      res.status(200).json({
        requiresPasswordReset: true,
        user: {
          id: existingUser.id,
          email: existingUser.email,
          first_name: existingUser.first_name,
          last_name: existingUser.last_name,
          phone_number: existingUser.phone_number,
          is_active: existingUser.is_active,
          created_at: existingUser.created_at,
          updated_at: existingUser.updated_at,
        },
        message: "Please reset your password to continue",
      });
    } else {
      // check password
      const isValidPassword = await bcrypt.compare(
        password,
        existingUser.password,
      );

      if (!isValidPassword) {
        throw new ApiError(401, "Invalid credentials");
      }

      // JWT logic for the user
      const accessToken = signAccessToken(existingUser);

      const refreshToken = await createRefreshToken({
        userId: existingUser.id,
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/auth/refresh",
      });

      // Response
      res.status(200).json({
        accessToken,
        user: {
          id: existingUser.id,
          email: existingUser.email,
          first_name: existingUser.first_name,
          last_name: existingUser.last_name,
          phone_number: existingUser.phone_number,
          is_active: existingUser.is_active,
          created_at: existingUser.created_at,
          updated_at: existingUser.updated_at,
        },
      });
    }
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

export const refreshAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token)
      return res.status(401).json({ message: "No refresh token provided" });

    const [tokenId, rawToken] = token.split(".");
    if (!tokenId || !rawToken)
      return res.status(401).json({ message: "Invalid token format" });

    const stored = await prisma.refresh_token.findUnique({
      where: { token_id: tokenId },
      include: { user: true },
    });

    // Token reuse/theft detection
    if (!stored) {
      return res.status(403).json({ message: "Token not found" });
    }

    if (stored.revoked) {
      // Possible token reuse - revoke all user's tokens
      await prisma.refresh_token.updateMany({
        where: { user_id: stored.user_id },
        data: { revoked: true },
      });
      return res
        .status(403)
        .json({ message: "Token reuse detected. All sessions revoked." });
    }

    if (stored.expires_at < new Date()) {
      return res.status(403).json({ message: "Refresh token expired" });
    }
    const valid = await bcrypt.compare(rawToken, stored.token_hash);
    if (!valid) return res.sendStatus(403);

    // 🔁 ROTATION
    await prisma.refresh_token.update({
      where: { token_id: tokenId },
      data: { revoked: true },
    });

    const newRefreshToken = await createRefreshToken({
      userId: stored.user.id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    const accessToken = signAccessToken(stored.user);

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/auth/refresh",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ accessToken });
  } catch (error) {
    next(error);
  }
};

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      res.sendStatus(204);
      return;
    }

    const [tokenId] = token.split(".");

    await prisma.refresh_token.updateMany({
      where: { token_id: tokenId },
      data: { revoked: true },
    });

    res.clearCookie("refreshToken", { path: "/auth/refresh" });
    res.status(204).json({
      message: "User Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const verifyOtpLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { phone, otp } = req.body;

    const otpRecord = await prisma.user_otps.findFirst({
      where: {
        phone,
        is_used: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: "desc" },
    });

    if (!otpRecord) return res.sendStatus(401);

    const valid = await bcrypt.compare(otp, otpRecord.otp_hash);
    if (!valid) return res.sendStatus(401);

    await prisma.user_otps.update({
      where: { id: otpRecord.id },
      data: { is_used: true },
    });

    const user = await prisma.users.findUnique({
      where: { phone_number: phone },
    });
    if (!user) return res.sendStatus(404);

    const accessToken = signAccessToken(user);
    const refreshToken = await createRefreshToken({
      userId: user.id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/auth/refresh",
    });

    res.json({ accessToken });
  } catch (error) {
    next(error);
  }
};

// controllers/authController.ts
export const resetDefaultPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email, currentPassword, newPassword } = req.body;

    if (!email || !currentPassword || !newPassword) {
      throw new ApiError(400, "All fields are required");
    }

    // Find user
    const user = await prisma.users.findUnique({
      where: { email },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!isValidPassword) {
      throw new ApiError(401, "Current password is incorrect");
    }

    // Check if user is in default login state
    if (!user.is_default_login) {
      throw new ApiError(400, "Password already reset");
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and set is_default_login to false
    await prisma.users.update({
      where: { email },
      data: {
        password: hashedPassword,
        is_default_login: false, // ✅ Mark as password reset
        updated_at: new Date(),
      },
    });

    res.status(200).json({
      message:
        "Password reset successfully. Please login with your new password.",
    });
  } catch (error) {
    next(error);
  }
};

// Request password reset
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new ApiError(400, "Email is required");
    }

    // Find user
    const user = await prisma.users.findUnique({
      where: { email },
    });

    // ⚠️ Always return success to prevent email enumeration
    if (!user) {
      return res.status(200).json({
        message:
          "If an account exists with this email, you will receive a password reset link.",
      });
    }

    // Generate reset token (random 32-byte hex string)
    const resetToken = crypto.randomBytes(32).toString("hex");

    // Hash token before storing (security best practice)
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // Invalidate any existing tokens for this user
    await prisma.password_reset_token.updateMany({
      where: {
        user_id: user.id,
        used: false,
      },
      data: { used: true },
    });

    // Create new reset token (expires in 1 hour)
    await prisma.password_reset_token.create({
      data: {
        user_id: user.id,
        token: hashedToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Send email with original (unhashed) token
    // await sendPasswordResetEmail(user.email, resetToken);

    res.status(200).json({
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  } catch (error) {
    next(error);
  }
};

// Verify reset token (optional - for checking token validity)
export const verifyResetToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.params;

    // ✅ Type guard - ensure token is a string
    if (!token || typeof token !== "string") {
      throw new ApiError(400, "Token is required");
    }

    // Hash the token from URL
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find valid token
    const resetToken = await prisma.password_reset_token.findFirst({
      where: {
        token: hashedToken,
        used: false,
        expires_at: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!resetToken) {
      throw new ApiError(400, "Invalid or expired reset token");
    }

    res.status(200).json({
      valid: true,
      email: resetToken.user.email, // Return email to show on form
    });
  } catch (error) {
    next(error);
  }
};

// Reset password with token
export const resetPasswordWithToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    // ✅ Type guard - ensure token is a string
    if (!token || typeof token !== "string") {
      throw new ApiError(400, "Token is required");
    }

    if (!newPassword) {
      throw new ApiError(400, "New password is required");
    }

    // Hash the token from URL
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find valid token
    const resetToken = await prisma.password_reset_token.findFirst({
      where: {
        token: hashedToken,
        used: false,
        expires_at: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!resetToken) {
      throw new ApiError(400, "Invalid or expired reset token");
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and mark token as used
    await prisma.$transaction([
      prisma.users.update({
        where: { id: resetToken.user_id },
        data: {
          password: hashedPassword,
          is_default_login: false, // User has set their own password
          updated_at: new Date(),
        },
      }),
      prisma.password_reset_token.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
      // Revoke all refresh tokens (logout from all devices)
      prisma.refresh_token.updateMany({
        where: { user_id: resetToken.user_id },
        data: { revoked: true },
      }),
    ]);

    res.status(200).json({
      message:
        "Password reset successfully. Please login with your new password.",
    });
  } catch (error) {
    next(error);
  }
};

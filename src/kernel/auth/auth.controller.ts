import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { SALT_ROUNDS } from "@shared/utils/contants";

import { checkOtpLimit, updateOtpLimit } from "./otpRateLimiter";
import { buildUserPermissions } from "@kernel/rbac/userPermission";
// import { sendPasswordResetEmail } from "../utils/sendEmail";
import { signAccessToken, createRefreshToken } from "./auth.services";
import { OtpService } from "./otp.services";

const otpService = new OtpService();

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
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ApiError(409, "User already exists");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Save user
    const user = await prisma.user.create({
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
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (!existingUser) {
      throw new ApiError(409, "User does not exist, Please register");
    }

    // ✅ NEW: Check if user needs to reset default password
    if (existingUser.is_default_login) {
      if (password !== existingUser.password) {
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

      // Load workspace membership (single workspace system)
      const workspace = await prisma.workspaceUser.findFirst({
        where: { userId: existingUser.id },
        select: {
          workspaceId: true,
          isSuperAdmin: true,
        },
      });

      if (!workspace) {
        throw new ApiError(403, "User not assigned to workspace");
      }

      // 🔥 Load module-level permissions
      const permissions = await buildUserPermissions(
        existingUser.id,
        workspace.workspaceId,
      );

      // Create JWT with workspace context
      const accessToken = signAccessToken({
        id: existingUser.id,
        workspaceId: workspace.workspaceId,
        isSuperAdmin: workspace.isSuperAdmin,
      });

      const refreshToken = await createRefreshToken({
        userId: existingUser.id,
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
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
        workspaceId: workspace.workspaceId,
        permissions,
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

    const user = await prisma.user.findUnique({
      where: { phone_number },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    if (!user.is_active) {
      throw new ApiError(403, "Account is inactive");
    }

    // 🔒 Redis rate-limit check
    const limit = await checkOtpLimit(phone_number);
    if (!limit.allowed) {
      throw new ApiError(429, limit.message || "Failed to send OTP");
    }

    const data = await otpService.sendOtp(phone_number);

    if (data.type === "error") {
      throw new ApiError(401, data.message || "Failed to send OTP");
    }

    await updateOtpLimit(phone_number);

    res.status(200).json({
      success: true,
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

    if (!phone_number || !otp) {
      throw new ApiError(400, "Phone number and OTP are required");
    }

    // 1️⃣ Verify OTP
    const otpResult = await otpService.verifyOtp(phone_number, otp);

    if (otpResult.type !== "success") {
      throw new ApiError(400, otpResult.message || "Invalid or expired OTP");
    }

    // 2️⃣ Fetch user
    const user = await prisma.user.findUnique({
      where: { phone_number },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    if (!user.is_active) {
      throw new ApiError(403, "Account is inactive");
    }

    // Load workspace membership (single workspace system)
    const workspace = await prisma.workspaceUser.findFirst({
      where: { userId: user.id },
      select: {
        workspaceId: true,
        isSuperAdmin: true,
      },
    });

    if (!workspace) {
      throw new ApiError(403, "User not assigned to workspace");
    }

    // 🔥 Load module-level permissions
    const permissions = await buildUserPermissions(
      user.id,
      workspace.workspaceId,
    );

    // Create JWT with workspace context
    const accessToken = signAccessToken({
      id: user.id,
      workspaceId: workspace.workspaceId,
      isSuperAdmin: workspace.isSuperAdmin,
    });

    const refreshToken = await createRefreshToken({
      userId: user.id,
      userAgent: req.headers["user-agent"],
      ipAddress: Array.isArray(req.ip) ? req.ip[0] : req.ip,
    });

    // 4️⃣ Set refresh token cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // 5️⃣ Success response
    res.status(200).json({
      success: true,
      message: "Login successful",
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        phone_number: user.phone_number,
      },
      workspaceId: workspace.workspaceId,
      permissions,
    });
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
    console.log("Cookie==============>", JSON.stringify(req.cookies, null, 2));
    const token = req.cookies.refreshToken;
    if (!token) throw new ApiError(401, "No refresh token provided");

    const [tokenId, rawToken] = token.split(".");
    if (!tokenId || !rawToken) throw new ApiError(401, "Invalid token format");

    const stored = await prisma.refreshToken.findUnique({
      where: { token_id: tokenId },
      include: { user: true },
    });

    // Token reuse/theft detection
    if (!stored) {
      throw new ApiError(403, "Token not found");
    }

    if (stored.revoked) {
      // Possible token reuse - revoke all user's tokens
      await prisma.refreshToken.updateMany({
        where: { user_id: stored.user_id },
        data: { revoked: true },
      });
      throw new ApiError(403, "Token reuse detected. All sessions revoked.");
    }

    if (stored.expires_at < new Date()) {
      throw new ApiError(403, "Refresh token expired");
    }
    const valid = await bcrypt.compare(rawToken, stored.token_hash);
    if (!valid) throw new ApiError(403, "Token not valid.");

    // 🔁 ROTATION
    await prisma.refreshToken.update({
      where: { token_id: tokenId },
      data: { revoked: true },
    });

    const newRefreshToken = await createRefreshToken({
      userId: stored.user.id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    // Load workspace membership (single workspace system)
    const workspace = await prisma.workspaceUser.findFirst({
      where: { userId: stored.user.id },
      select: {
        workspaceId: true,
        isSuperAdmin: true,
      },
    });

    if (!workspace) {
      throw new ApiError(403, "User not assigned to workspace");
    }

    // Create JWT with workspace context
    const accessToken = signAccessToken({
      id: stored.user.id,
      workspaceId: workspace.workspaceId,
      isSuperAdmin: workspace.isSuperAdmin,
    });

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
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

    await prisma.refreshToken.updateMany({
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
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    if (currentPassword !== user.password) {
      throw new ApiError(401, "Current password is incorrect");
    }

    // Check if user is in default login state
    if (!user.is_default_login) {
      throw new ApiError(400, "Password already reset");
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and set is_default_login to false
    await prisma.user.update({
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
    const user = await prisma.user.findUnique({
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
    await prisma.passwordResetToken.updateMany({
      where: {
        user_id: user.id,
        used: false,
      },
      data: { used: true },
    });

    // Create new reset token (expires in 1 hour)
    await prisma.passwordResetToken.create({
      data: {
        user_id: user.id,
        token: hashedToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Send email with original (unhashed) token
    // await sendPasswordResetEmail(user.email, resetToken);
    console.log(
      "Forgot password link==========>",
      `${process.env.FRONTEND_URL}/reset-password/${resetToken}`,
    );

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
    const resetToken = await prisma.passwordResetToken.findFirst({
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
    const resetToken = await prisma.passwordResetToken.findFirst({
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
      prisma.user.update({
        where: { id: resetToken.user_id },
        data: {
          password: hashedPassword,
          is_default_login: false, // User has set their own password
          updated_at: new Date(),
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
      // Revoke all refresh tokens (logout from all devices)
      prisma.refreshToken.updateMany({
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

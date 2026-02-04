import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import {
  registerUser,
  loginWithPassword,
  sendOtp,
  verifyOtp,
  refreshAccessToken,
  logout,
  resetDefaultPassword,
  forgotPassword,
  verifyResetToken,
  resetPasswordWithToken,
} from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(registerUser));
router.post("/login", asyncHandler(loginWithPassword));
router.post("/reset-password", resetDefaultPassword);
router.post("/forgot-password", forgotPassword);
router.get("/reset-token/:token", verifyResetToken);
router.post("/reset-password/:token", resetPasswordWithToken);
router.post("/send-otp", asyncHandler(sendOtp));
router.post("/verify-otp", asyncHandler(verifyOtp));
router.post("/refresh", asyncHandler(refreshAccessToken));
router.post("/logout", requireAuth, asyncHandler(logout));

export default router;

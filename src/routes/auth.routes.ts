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
} from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(registerUser));
router.post("/login", asyncHandler(loginWithPassword));
router.post("/send-otp", asyncHandler(sendOtp));
router.post("/verify-otp", asyncHandler(verifyOtp));
// router.post("/refresh", asyncHandler(refreshAccessToken));
router.post("/logout", requireAuth, asyncHandler(logout));

export default router;

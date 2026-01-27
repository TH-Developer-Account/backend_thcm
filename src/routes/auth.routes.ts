import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  registerUser,
  loginUser,
  sendOtp,
  verifyOtp,
} from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(registerUser));
router.post("/login", asyncHandler(loginUser));
router.post("/send-otp", asyncHandler(sendOtp));
router.post("/verify-otp", asyncHandler(verifyOtp));

export default router;

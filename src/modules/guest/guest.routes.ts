import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import {
  sendGuestOtp,
  verifyGuestOtp,
  loginGuestWithPassword,
} from "./guest.controller";

const router = Router();

router.post("/send-otp", asyncHandler(sendGuestOtp));
router.post("/verify-otp", asyncHandler(verifyGuestOtp));
router.post("/login", asyncHandler(loginGuestWithPassword));

export default router;

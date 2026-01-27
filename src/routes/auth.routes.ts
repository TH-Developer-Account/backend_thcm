import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { registerUser, loginUser } from "../controllers/auth.controller";

const router = Router();

router.post("/register", asyncHandler(registerUser));
router.post("/login", asyncHandler(loginUser));

export default router;

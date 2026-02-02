import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { getUsers, getCurrentUser } from "../controllers/user.controller";

const router = Router();

router.get("/", asyncHandler(getUsers));
router.get("/me", requireAuth, asyncHandler(getCurrentUser));

export default router;

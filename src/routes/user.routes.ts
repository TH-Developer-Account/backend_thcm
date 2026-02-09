import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import { getUsers, getCurrentUser } from "../controllers/user.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getUsers));
router.get("/me", asyncHandler(getCurrentUser));

export default router;

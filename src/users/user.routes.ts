import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "../kernel/auth/auth.middleware";
import {
  getUsers,
  getCurrentUser,
  getByDEmployees,
  getC4CEmployees,
  assignUserProfiles,
} from "../users/user.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getUsers));
router.get("/me", asyncHandler(getCurrentUser));
router.get("/byd-employees", asyncHandler(getByDEmployees));
router.get("/c4c-employees", asyncHandler(getC4CEmployees));
router.post("/assign-profile", asyncHandler(assignUserProfiles));
export default router;

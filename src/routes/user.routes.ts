import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  getUsers,
  getCurrentUser,
  getByDEmployees,
  getC4CEmployees,
  assignUserProfiles,
} from "../controllers/user.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getUsers));
router.get("/me", asyncHandler(getCurrentUser));
router.get("/byd-employees", asyncHandler(getByDEmployees));
router.get("/c4c-employees", asyncHandler(getC4CEmployees));
router.post("/assign-profile", asyncHandler(assignUserProfiles));
export default router;

import { Router, Request, Response, NextFunction } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, requireSuperAdmin } from "../kernel/auth/auth.middleware";
import {
  getUsers,
  getCurrentUser,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
  getByDEmployees,
  getC4CEmployees,
  assignUserProfiles,
  removeUserFromWorkspace,
} from "../users/user.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getUsers));
router.get("/me", asyncHandler(getCurrentUser));
router.get("/byd-employees", asyncHandler(getByDEmployees));
router.get("/c4c-employees", asyncHandler(getC4CEmployees));
router.post("/assign-profile", asyncHandler(assignUserProfiles));

router.get("/:id", asyncHandler(getUserById));
router.post("/", requireSuperAdmin, asyncHandler(createUser));
router.patch("/:id", requireSuperAdmin, asyncHandler(updateUser));
router.delete("/:id", requireSuperAdmin, asyncHandler(deactivateUser));
router.delete(
  "/workspace-users/:userId",
  requireSuperAdmin,
  asyncHandler(removeUserFromWorkspace),
);

export default router;

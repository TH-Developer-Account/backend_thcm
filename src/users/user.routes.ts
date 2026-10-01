import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import {
  requireAdministrationAccess,
  requireAuth,
  requireSuperAdmin,
} from "@kernel/auth/auth.middleware";

import {
  createUser,
  deactivateUser,
  getByDEmployees,
  getC4CEmployees,
  getCurrentUser,
  getUserById,
  getUsers,
  removeUserFromWorkspace,
  updateUser,
} from "./user.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

router.get("/me", asyncHandler(getCurrentUser));

router.get(
  "/byd-employees",
  requireAdministrationAccess,
  asyncHandler(getByDEmployees),
);
router.get(
  "/c4c-employees",
  requireAdministrationAccess,
  asyncHandler(getC4CEmployees),
);

router.get("/", requireAdministrationAccess, asyncHandler(getUsers));
router.post("/", requireAdministrationAccess, asyncHandler(createUser));

router.delete(
  "/workspace-users/:userId",
  requireSuperAdmin,
  asyncHandler(removeUserFromWorkspace),
);

router.get("/:id", requireAdministrationAccess, asyncHandler(getUserById));
router.patch("/:id", requireSuperAdmin, asyncHandler(updateUser));
router.delete("/:id", requireSuperAdmin, asyncHandler(deactivateUser));

export default router;

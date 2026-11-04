import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, requireSuperAdmin } from "@kernel/auth/auth.middleware";

import {
  getBudgetOData,
  getMasterData,
  getProductsByType,
  manageMasterData,
} from "./masterData.controller";

const router = Router();

// Dropdown data is read by every app's forms, so any signed-in user may read
// it; only a super admin may change it.
router.use(requireAuth);

router.get("/", asyncHandler(getMasterData));
router.get("/products", asyncHandler(getProductsByType));
router.get("/budget", asyncHandler(getBudgetOData));
router.post("/manage", requireSuperAdmin, asyncHandler(manageMasterData));

export default router;

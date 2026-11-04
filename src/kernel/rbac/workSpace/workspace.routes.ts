import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, requireSuperAdmin } from "@kernel/auth/auth.middleware";

import { setupWorkspace, updateWorkspace } from "./workspace.controller";

const router = Router();

router.use(requireAuth);
router.use(requireSuperAdmin);

router.post("/create", asyncHandler(setupWorkspace));
router.post("/update", asyncHandler(updateWorkspace));

export default router;

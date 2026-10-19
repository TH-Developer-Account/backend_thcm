/**
 * routes/operator.route.js
 */
import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { internalAuth } from "@kernel/auth/internalAuth.middleware";
import { registerOperator } from "@kernel/reference-data/operator.controller";

const router = Router();

// All routes here are internal-only — guarded by the shared API key
router.post("/register", internalAuth, asyncHandler(registerOperator));

export default router;

/**
 * routes/operator.route.js
 */
import { Router } from "express";
import { internalAuth } from "../middleware/internalAuth.middleware";
import asyncHandler from "../middleware/async.middleware";
import { registerOperator } from "../controllers/operator.controller";

const router = Router();

// All routes here are internal-only — guarded by the shared API key
router.post("/register", internalAuth, asyncHandler(registerOperator));

export default router;

import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  approveStageController,
  assignWorkflowController,
} from "../controllers/workflow.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.post("/stages/:stageId/approve", asyncHandler(approveStageController));
router.post("/assign-workflow", asyncHandler(assignWorkflowController));

export default router;

import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  approveStageController,
  assignWorkflowController,
  clarifyStageController,
  triggerDeviationController,
  getWorkflowController,
  getWorkflowHistoryController,
} from "../controllers/workflow.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";

const router = Router();

// router.use(requireAuth); // sets req.user
// router.use(firstAuthRequestPerDay); // tracks DAU

router.post("/stages/:stageId/approve", asyncHandler(approveStageController));
router.post("/assign-workflow", asyncHandler(assignWorkflowController));
router.post("/stages/:stageId/clarify", asyncHandler(clarifyStageController));
router.post(
  "/stages/:stageId/trigger-deviation",
  asyncHandler(triggerDeviationController),
);
router.get("/workflow-instance/:id", asyncHandler(getWorkflowController));
router.get(
  "/workflow-instance/:id/history",
  asyncHandler(getWorkflowHistoryController),
);

export default router;

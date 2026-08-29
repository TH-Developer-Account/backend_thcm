import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import {
  approveStageController,
  assignWorkflowController,
  clarifyStageController,
  triggerDeviationController,
  getWorkflowController,
  getWorkflowHistoryController,
  previewWorkflowController,
  activateFirstStageController,
} from "./workflow.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.post("/stages/:stageId/approve", asyncHandler(approveStageController));
router.post("/assign-workflow", asyncHandler(assignWorkflowController));
router.post("/preview-workflow", asyncHandler(previewWorkflowController));
router.post("/stages/:stageId/clarify", asyncHandler(clarifyStageController));
router.post(
  "/stages/activate-first-stage",
  asyncHandler(activateFirstStageController),
);
router.post(
  "/stages/trigger-deviation",
  asyncHandler(triggerDeviationController),
);
router.get("/workflow-instance/:id", asyncHandler(getWorkflowController));
router.get(
  "/workflow-instance/:id/history",
  asyncHandler(getWorkflowHistoryController),
);

export default router;

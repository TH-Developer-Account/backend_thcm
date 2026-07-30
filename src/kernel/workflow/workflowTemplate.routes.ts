import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, authorize } from "@auth/auth.middleware";
import {
  createTemplateController,
  updateTemplate,
  deleteTemplate,
  getTemplates,
  getTemplateById,
  assignUsersToWorkflow,
} from "./workflowTemplate.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/assign-profile", asyncHandler(assignUsersToWorkflow));
router.post("/", asyncHandler(createTemplateController));

router.post("/update/:templateId", asyncHandler(updateTemplate));
router.delete("/delete/:templateId", asyncHandler(deleteTemplate));

router.get("/", asyncHandler(getTemplates));
router.get("/:templateId", asyncHandler(getTemplateById));

export default router;

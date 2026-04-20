import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  createTemplateController,
  updateTemplate,
  deleteTemplate,
  getTemplates,
  getTemplateById,
  assignUsersToWorkflow,
} from "../controllers/workflowTemplate.controller";

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

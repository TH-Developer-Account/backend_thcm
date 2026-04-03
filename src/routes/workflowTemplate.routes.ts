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
} from "../controllers/workflowTemplate.controller";

const router = Router();

// router.use(requireAuth); // sets req.user
// router.use(firstAuthRequestPerDay);

router.post("/", asyncHandler(createTemplateController));
router.get("/", asyncHandler(getTemplates));
router.get("/:templateId", asyncHandler(getTemplateById));
router.put("/:templateId", asyncHandler(updateTemplate));
router.delete("/:templateId", asyncHandler(deleteTemplate));

export default router;

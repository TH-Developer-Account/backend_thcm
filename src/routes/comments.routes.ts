import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  addComment,
  getWorkflowComments,
} from "../controllers/comment.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/", asyncHandler(addComment));
router.get("/:workflowInstanceId", asyncHandler(getWorkflowComments));

export default router;

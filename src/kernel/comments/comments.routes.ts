import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth, authorize } from "../auth/auth.middleware";
import {
  addComment,
  getComments,
  getActivityLog,
  addCreatorComment,
} from "./comment.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/", asyncHandler(addComment));
router.post(
  "/:subjectType/:subjectId/creator-comment",
  asyncHandler(addCreatorComment),
);
router.get("/:subjectType/:subjectId/comments", asyncHandler(getComments));
router.get(
  "/:subjectType/:subjectId/activity-log",
  asyncHandler(getActivityLog),
);

export default router;

import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth, authorize } from "../auth/auth.middleware";
import {
  addComment,
  getActivityFeed,
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
router.get("/:subjectType/:subjectId/activity", asyncHandler(getActivityFeed));

export default router;

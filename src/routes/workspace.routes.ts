import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  setupWorkspaceRBAC,
  updateWorkspaceRBAC,
} from "../controllers/workspace.controller";

const router = Router();

router.post("/create", asyncHandler(setupWorkspaceRBAC));
router.post("/update/:workSpaceId", asyncHandler(updateWorkspaceRBAC));

export default router;

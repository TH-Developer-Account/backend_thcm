import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import {
  setupWorkspaceRBAC,
  updateWorkspaceRBAC,
} from "./workspace.controller";

const router = Router();

router.post("/create", asyncHandler(setupWorkspaceRBAC));
router.post("/update/:workSpaceId", asyncHandler(updateWorkspaceRBAC));

export default router;

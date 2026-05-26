import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  setupWorkspaceRBAC,
  updateWorkspaceRBAC,
  togglePeerToPeer,
  getWorkspaceSettings,
} from "../controllers/workspace.controller";
import { requireSuperAdmin } from "../middleware/isSuperAdmin.middleware";

const router = Router();

router.get("/:workspaceId", asyncHandler(getWorkspaceSettings));
router.post("/create", asyncHandler(setupWorkspaceRBAC));
router.post("/update/:workSpaceId", asyncHandler(updateWorkspaceRBAC));
router.patch(
  "/peer-to-peer",
  requireSuperAdmin,
  asyncHandler(togglePeerToPeer),
);

export default router;

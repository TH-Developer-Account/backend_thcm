import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  setupWorkspaceRBAC,
  updateWorkspaceRBAC,
  deleteWorkspaceRBAC,
  getAllWorkspaces,
  getWorkspaceById,
  assignUserToWorkspace,
  removeUserFromWorkspace,
} from "../controllers/workspace.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getAllWorkspaces));
router.get("/:workspaceId", asyncHandler(getWorkspaceById));
router.post("/create", asyncHandler(setupWorkspaceRBAC));
router.put("/update/:workSpaceId", asyncHandler(updateWorkspaceRBAC));
router.delete("/delete/:workSpaceId", asyncHandler(deleteWorkspaceRBAC));
router.put("/assign-users", asyncHandler(assignUserToWorkspace));
router.put("/remove-users", asyncHandler(removeUserFromWorkspace));

export default router;

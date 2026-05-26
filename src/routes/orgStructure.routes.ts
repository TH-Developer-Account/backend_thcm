import { Router } from "express";
import {
  createOrgUnit,
  getOrgTree,
  getOrgUnitById,
  deleteOrgUnit,
  addMember,
  removeMember,
  getMembers,
  getMyTeam,
} from "../controllers/orgUnit.controller";

import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import { requireSuperAdmin } from "../middleware/isSuperAdmin.middleware"; // see note below

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

// ── Tree structure — super admin only ────────────────────────────────────────
router.post("/", requireSuperAdmin, createOrgUnit);
router.get("/", requireSuperAdmin, getOrgTree);
router.get("/my-team", getMyTeam); // must be before /:unitId
router.get("/:unitId", requireSuperAdmin, getOrgUnitById);
router.delete("/:unitId", requireSuperAdmin, deleteOrgUnit);

// ── Membership — super admin seeds, managers manage their own unit ────────────
router.post("/:unitId/members", addMember); // internally checks role
router.delete("/:unitId/members/:userId", removeMember);
router.get("/:unitId/members", getMembers);

export default router;

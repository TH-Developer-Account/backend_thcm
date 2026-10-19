import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import {
  requireAdministrationAccess,
  requireAppAdministration,
  requireAuth,
} from "@kernel/auth/auth.middleware";

import {
  appKeyFromBody,
  appKeyFromProfileParameter,
} from "../app/appResolvers";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
  updateProfileAssignees,
} from "./profile.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

const requireProfileAppAdministration = requireAppAdministration(
  appKeyFromProfileParameter("profileId"),
);

router.get("/", requireAdministrationAccess, asyncHandler(listProfiles));
router.post(
  "/create",
  requireAppAdministration(appKeyFromBody("appKey")),
  asyncHandler(createProfile),
);
router.get(
  "/:profileId",
  requireProfileAppAdministration,
  asyncHandler(getProfile),
);
router.patch(
  "/update/:profileId",
  requireProfileAppAdministration,
  asyncHandler(updateProfile),
);
router.delete(
  "/delete/:profileId",
  requireProfileAppAdministration,
  asyncHandler(deleteProfile),
);
router.put(
  "/:profileId/assignments",
  requireProfileAppAdministration,
  asyncHandler(updateProfileAssignees),
);

export default router;

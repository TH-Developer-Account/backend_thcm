import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import {
  requireAdministrationAccess,
  requireAppAdministration,
  requireAuth,
  requireSuperAdmin,
} from "@kernel/auth/auth.middleware";

import { appKeyFromRouteParameter } from "./appResolvers";
import {
  assignUserProfile,
  grantAdministrator,
  listAdministrators,
  listApps,
  removeUserProfile,
  revokeAdministrator,
} from "./app.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

const requireRouteAppAdministration = requireAppAdministration(
  appKeyFromRouteParameter("appKey"),
);

router.get("/", requireAdministrationAccess, asyncHandler(listApps));

router.get(
  "/:appKey/administrators",
  requireSuperAdmin,
  asyncHandler(listAdministrators),
);
router.put(
  "/:appKey/administrators/:userId",
  requireSuperAdmin,
  asyncHandler(grantAdministrator),
);
router.delete(
  "/:appKey/administrators/:userId",
  requireSuperAdmin,
  asyncHandler(revokeAdministrator),
);

router.put(
  "/:appKey/users/:userId/profile",
  requireRouteAppAdministration,
  asyncHandler(assignUserProfile),
);
router.delete(
  "/:appKey/users/:userId/profile",
  requireRouteAppAdministration,
  asyncHandler(removeUserProfile),
);

export default router;

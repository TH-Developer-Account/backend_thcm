import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import {
  requireAdministrationAccess,
  requireAuth,
} from "@kernel/auth/auth.middleware";

import {
  createAuthorityLimit,
  listAuthorityLimits,
  replaceAuthorityLimitAssignments,
  updateAuthorityLimit,
} from "./authoritySchedule.controller";

// Mount in app.ts the same way masterData.routes.ts is mounted, e.g.:
//   app.use("/api/v1/authority-schedule", authorityScheduleRoutes);
const router = Router();

router.use(requireAuth);

router.get(
  "/limits",
  requireAdministrationAccess,
  asyncHandler(listAuthorityLimits),
);
router.post(
  "/limits",
  requireAdministrationAccess,
  asyncHandler(createAuthorityLimit),
);
router.patch(
  "/limits/:id",
  requireAdministrationAccess,
  asyncHandler(updateAuthorityLimit),
);
router.put(
  "/limits/:id/assignments",
  requireAdministrationAccess,
  asyncHandler(replaceAuthorityLimitAssignments),
);

export default router;

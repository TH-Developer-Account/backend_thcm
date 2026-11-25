// handouts/handouts.routes.ts
//
// Route wiring — same convention as crf.routes.ts / crf-shop.routes.ts:
// requireAuth + firstAuthRequestPerDay at the router level, then
// authorize(appKey, moduleKey, action) per route. One RBAC module
// (HANDOUT_MODULE) gates every route; read vs write still differs per
// route, but there is no separate module per role — row-level actions
// (who may approve/deliver *this* request) are narrowed further by status
// in handoutsAccess.helper.ts's computeHandoutPermissions, not by RBAC.
//
// Mount in app.ts the same way crf.routes.ts is mounted, e.g.:
//   app.use("/api/v1/handouts", handoutsRoutes);

import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, authorize } from "@auth/auth.middleware";

import {
  postHandout,
  getHandouts,
  getHandoutById,
  postHandoutResubmit,
  postHandoutApprove,
  postHandoutReject,
  postHandoutClarify,
  postHandoutCancel,
  postHandoutCannotFulfil,
  postHandoutDeliver,
} from "./handouts.controller";
import { HANDOUT_APP, HANDOUT_MODULE } from "./handoutStatus.constants";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

// ── Requester surface ────────────────────────────────────────────────────────
router.post(
  "/",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandout),
);
router.get(
  "/",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "read"),
  asyncHandler(getHandouts),
);
router.get(
  "/:id",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "read"),
  asyncHandler(getHandoutById),
);
router.post(
  "/:id/resubmit",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutResubmit),
);
router.post(
  "/:id/cancel",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutCancel),
);

// ── Approver surface ─────────────────────────────────────────────────────────
router.post(
  "/:id/approve",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutApprove),
);
router.post(
  "/:id/reject",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutReject),
);
router.post(
  "/:id/clarify",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutClarify),
);

// ── Delivery-team surface ────────────────────────────────────────────────────
router.post(
  "/:id/cannot-fulfil",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutCannotFulfil),
);
router.post(
  "/:id/deliver",
  authorize(HANDOUT_APP, HANDOUT_MODULE, "write"),
  asyncHandler(postHandoutDeliver),
);

export default router;

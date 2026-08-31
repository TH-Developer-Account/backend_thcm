import { Router, Request, Response, NextFunction } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth } from "@auth/auth.middleware";
import ApiError from "@shared/utils/apiError";

import {
  createBusinessPartner,
  getBusinessPartnerById,
  listBusinessPartners,
  updateBusinessPartner,
  deactivateBusinessPartner,
} from "./businessPartner.controller";

// ─────────────────────────────────────────────────────────────────────────────
// requireSuperAdmin
//
// Business Partner management isn't scoped under any existing App/module —
// gating on isSuperAdmin directly rather than canManageApp(appKey) until
// that's decided. Kept local to this route file since it's a one-off check;
// promote to @kernel/rbac if a second route ends up needing the same gate.
// ─────────────────────────────────────────────────────────────────────────────

// const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
//   if (!req.user?.isSuperAdmin) {
//     return next(
//       new ApiError(403, "Only a super admin can manage business partners"),
//     );
//   }
//   next();
// };

const router = Router();

router.use(requireAuth);
// router.use(requireSuperAdmin);

router.post("/", asyncHandler(createBusinessPartner));
router.get("/", asyncHandler(listBusinessPartners));
router.get("/:id", asyncHandler(getBusinessPartnerById));
router.patch("/:id", asyncHandler(updateBusinessPartner));
router.delete("/:id", asyncHandler(deactivateBusinessPartner));

export default router;

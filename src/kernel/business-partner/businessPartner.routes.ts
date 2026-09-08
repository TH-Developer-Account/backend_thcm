import { Router, Request, Response, NextFunction } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, requireSuperAdmin } from "@auth/auth.middleware";

import {
  createBusinessPartner,
  getBusinessPartnerById,
  listBusinessPartners,
  updateBusinessPartner,
  deactivateBusinessPartner,
} from "./businessPartner.controller";

const router = Router();

router.use(requireAuth);
router.use(requireSuperAdmin);

router.post("/", asyncHandler(createBusinessPartner));
router.get("/", asyncHandler(listBusinessPartners));
router.get("/:id", asyncHandler(getBusinessPartnerById));
router.patch("/:id", asyncHandler(updateBusinessPartner));
router.delete("/:id", asyncHandler(deactivateBusinessPartner));

export default router;

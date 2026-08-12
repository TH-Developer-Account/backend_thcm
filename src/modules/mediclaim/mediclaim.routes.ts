import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import { requireGuestAuth } from "@guest/guest.middleware";
import {
  initiateMedicalClaim,
  resendMedicalClaimLink, // consider: still meaningful? see note below
  closeMedicalClaim,
  listMedicalClaims,
  getMedicalClaimById,
  exportMedicalClaimById,
  listGuestMedicalClaims,
  getGuestMedicalClaimById,
  submitGuestMedicalClaimForm,
  saveGuestMedicalClaimDraft,
} from "./mediclaim.controller";

const router = Router();
const APP_KEY = "MEDICAL_CLAIM";
const MODULE = "MEDICAL_CLAIM_INITIATION";

const upload = multer({ storage: multer.memoryStorage() });

// ── Guest surface ──
router.get("/guest", requireGuestAuth, asyncHandler(listGuestMedicalClaims));
router.get(
  "/guest/:id",
  requireGuestAuth,
  asyncHandler(getGuestMedicalClaimById),
);
router.patch(
  "/guest/:id/submit",
  requireGuestAuth,
  upload.array("billAttachments"),
  asyncHandler(submitGuestMedicalClaimForm),
);
router.patch(
  "/guest/:id/draft",
  requireGuestAuth,
  upload.array("billAttachments"),
  asyncHandler(saveGuestMedicalClaimDraft),
);

// ── Internal staff surface ──
router.get(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(listMedicalClaims),
);
router.get(
  "/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(getMedicalClaimById),
);
router.get(
  "/export/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(exportMedicalClaimById),
);
router.post(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(initiateMedicalClaim),
);
router.post(
  "/:id/close",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(closeMedicalClaim),
);

export default router;

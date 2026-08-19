import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import { requireGuestAuth } from "@guest/guest.middleware";
import { requireMedicalClaimAccessToken } from "./mediclaim.middleware";
import {
  initiateMedicalClaim,
  resendMedicalClaimLink,
  closeMedicalClaim,
  listMedicalClaims,
  getMedicalClaimById,
  exportMedicalClaimById,
  getMedicalClaimFormByToken,
  submitMedicalClaimForm,
  saveMedicalClaimDraft,
  listGuestMedicalClaims,
  getGuestMedicalClaimById,
  resubmitGuestMedicalClaim,
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
  "/guest/:id/resubmit",
  requireGuestAuth,
  upload.array("billAttachments"),
  asyncHandler(resubmitGuestMedicalClaim),
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
  "/:id/resend-link",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(resendMedicalClaimLink),
);
router.post(
  "/:id/close",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(closeMedicalClaim),
);

// ── First-touch, token-based (AWAITING_EX_EMPLOYEE only) ──
router.get(
  "/public/:token",
  requireMedicalClaimAccessToken,
  asyncHandler(getMedicalClaimFormByToken),
);
router.post(
  "/public/:token/submit",
  requireMedicalClaimAccessToken,
  upload.array("billAttachments"),
  asyncHandler(submitMedicalClaimForm),
);
router.patch(
  "/public/:token/draft",
  requireMedicalClaimAccessToken,
  upload.array("billAttachments"),
  asyncHandler(saveMedicalClaimDraft),
);

export default router;

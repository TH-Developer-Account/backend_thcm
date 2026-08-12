import { Router } from "express";
import multer from "multer";

import asyncHandler from "@shared/middleware/async.middleware";
import { ALL_VENDOR_DOCUMENT_TYPES } from "@shared/utils/contants";

import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import { requireGuestAuth } from "@guest/guest.middleware";

import {
  initiateVendorOnboarding,
  resendVendorLink, // consider: still meaningful? see note below
  updateEmployeeFields,
  sendForApproval,
  closeVendorOnboarding,
  submitGuestVendorOnboardingForm,
  saveGuestVendorOnboardingDraft,
  listVendorOnboardings,
  getVendorOnboardingById,
  sendBackToVendor,
  getVendorOnboardingPdfByToken,
  exportVendorOnboardingById,
  listGuestVendorOnboardings,
  getGuestVendorOnboardingById,
} from "./vendorOnboarding.controller";

const router = Router();

const APP_KEY = "VENDOR_ONBOARDING";
const MODULE = "VENDOR_INITIATION";

const upload = multer({ storage: multer.memoryStorage() });

const documentUploadFields = ALL_VENDOR_DOCUMENT_TYPES.map((name) => ({
  name,
  maxCount: 1,
}));

// ── Guest surface ── (must stay above "/:id" — see earlier shadowing note)
router.get(
  "/guest",
  requireGuestAuth,
  asyncHandler(listGuestVendorOnboardings),
);
router.get(
  "/guest/:id",
  requireGuestAuth,
  asyncHandler(getGuestVendorOnboardingById),
);
router.patch(
  "/guest/:id/submit",
  requireGuestAuth,
  upload.fields(documentUploadFields),
  asyncHandler(submitGuestVendorOnboardingForm),
);
router.patch(
  "/guest/:id/draft",
  requireGuestAuth,
  upload.fields(documentUploadFields),
  asyncHandler(saveGuestVendorOnboardingDraft),
);

// ── Internal staff surface ──
router.get(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(listVendorOnboardings),
);
router.get(
  "/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(getVendorOnboardingById),
);
router.get(
  "/export/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(exportVendorOnboardingById),
);
router.post(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(initiateVendorOnboarding),
);
router.patch(
  "/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(updateEmployeeFields),
);
router.post(
  "/:id/send-for-approval",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(sendForApproval),
);
router.post(
  "/:id/close",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(closeVendorOnboarding),
);
router.post(
  "/:id/send-back-to-vendor",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(sendBackToVendor),
);

// PDF view link — unrelated to form access, stays token-based (VIEW_PDF
// purpose, not FORM_ACCESS). Untouched by this change.
router.get("/public/pdf/:token", asyncHandler(getVendorOnboardingPdfByToken));

export default router;

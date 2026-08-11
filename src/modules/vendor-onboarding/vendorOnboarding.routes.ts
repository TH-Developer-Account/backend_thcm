import { Router } from "express";
import multer from "multer";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { ALL_VENDOR_DOCUMENT_TYPES } from "@shared/utils/contants";

import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import { requireGuestAuth } from "@guest/guest.middleware";

import {
  initiateVendorOnboarding,
  resendVendorLink,
  updateEmployeeFields,
  sendForApproval,
  closeVendorOnboarding,
  getVendorFormByToken,
  submitVendorForm,
  listVendorOnboardings,
  getVendorOnboardingById,
  sendBackToVendor,
  getVendorOnboardingPdfByToken,
  exportVendorOnboardingById,
  saveVendorFormDraft,
  listGuestVendorOnboardings,
  getGuestVendorOnboardingById,
} from "./vendorOnboarding.controller";
import { requireVendorAccessToken } from "./vendorAccessToken.middleware";

const router = Router();

const APP_KEY = "VENDOR_ONBOARDING";
const MODULE = "VENDOR_INITIATION"; // per your single-module decision

// In-memory storage — matches uploadDeviationDoc's use of req.file.buffer
// elsewhere, so uploadToS3 keeps receiving a Buffer, not a disk path.
const upload = multer({ storage: multer.memoryStorage() });

// Each fixed document type becomes its own named multipart field —
// lets submitVendorForm validate presence per REQUIRED_VENDOR_DOCUMENT_TYPES
// via req.files[documentType], no parsing an arbitrary file array.
const documentUploadFields = ALL_VENDOR_DOCUMENT_TYPES.map((name) => ({
  name,
  maxCount: 1,
}));

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

// List — defaults to "mine", ?scope=workspace for superadmins to see all.
router.get(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "read"),
  asyncHandler(listVendorOnboardings),
);

// GET /api/v1/vendor-onboarding/:id
// Detail page — onboarding + documents + active workflow.
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

// POST /api/v1/vendor-onboarding
router.post(
  "/",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(initiateVendorOnboarding),
);

// POST /api/v1/vendor-onboarding/:id/resend-link
router.post(
  "/:id/resend-link",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(resendVendorLink),
);

// PATCH /api/v1/vendor-onboarding/:id
router.patch(
  "/:id",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(updateEmployeeFields),
);

// POST /api/v1/vendor-onboarding/:id/send-for-approval
router.post(
  "/:id/send-for-approval",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(sendForApproval),
);

// POST /api/v1/vendor-onboarding/:id/close
router.post(
  "/:id/close",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(closeVendorOnboarding),
);

// GET /api/v1/vendor-onboarding/public/:token
router.get(
  "/public/:token",
  requireVendorAccessToken,
  asyncHandler(getVendorFormByToken),
);

// POST /api/v1/vendor-onboarding/public/:token/submit
router.post(
  "/public/:token/submit",
  requireVendorAccessToken,
  upload.fields(documentUploadFields),
  asyncHandler(submitVendorForm),
);

router.get("/public/pdf/:token", asyncHandler(getVendorOnboardingPdfByToken));

router.post(
  "/:id/send-back-to-vendor",
  requireAuth,
  authorize(APP_KEY, MODULE, "write"),
  asyncHandler(sendBackToVendor),
);

router.patch(
  "/public/:token/draft",
  requireVendorAccessToken,
  upload.fields(documentUploadFields),
  asyncHandler(saveVendorFormDraft),
);

export default router;

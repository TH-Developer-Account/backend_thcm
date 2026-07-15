import { Router } from "express";
import multer from "multer";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import {
	initiateVendorOnboarding,
	resendVendorLink,
	updateEmployeeFields,
	sendForApproval,
	closeVendorOnboarding,
	getVendorFormByToken,
	submitVendorForm,
} from "../controllers/vendorOnboarding.controller";
import { requireVendorAccessToken } from "../middleware/vendorAccessToken.middleware";

import { REQUIRED_VENDOR_DOCUMENT_TYPES } from "../utils/contants";

const router = Router();

const APP_KEY = "VENDOR_ONBOARDING";
const MODULE = "Vendor Initiation"; // per your single-module decision

// In-memory storage — matches uploadDeviationDoc's use of req.file.buffer
// elsewhere, so uploadToS3 keeps receiving a Buffer, not a disk path.
const upload = multer({ storage: multer.memoryStorage() });

// Each fixed document type becomes its own named multipart field —
// lets submitVendorForm validate presence per REQUIRED_VENDOR_DOCUMENT_TYPES
// via req.files[documentType], no parsing an arbitrary file array.
const documentUploadFields = REQUIRED_VENDOR_DOCUMENT_TYPES.map((name) => ({
	name,
	maxCount: 1,
}));

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

export default router;

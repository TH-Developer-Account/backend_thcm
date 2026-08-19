import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@auth/auth.middleware";
import {
  submitReport,
  resubmitReport,
  getReport,
  validateReport,
  requestReportClarification,
  getReportFormConfig,
} from "@map/report.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

const uploadReportImages = multer({
  storage: multer.memoryStorage(),
}).array("images", 10);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
//
// Mounted under /api/v1/report — full paths:
//   GET    /api/v1/report/form-config/:epcId
//   POST   /api/v1/report/:epcId/submit
//   PATCH  /api/v1/report/:epcId/resubmit
//   GET    /api/v1/report/:epcId
//   POST   /api/v1/report/:reportId/validate
//   POST   /api/v1/report/:reportId/request-clarification
//
// Image upload uses one "images" field (multer .array, up to 10 files) —
// not fixed named fields — since image count is now template-driven
// (minImages/maxImages per event type), not a fixed 4. Mime type and size
// validation happens in the controller (assertValidImageFile), not here,
// so error messages can be specific rather than a generic multer rejection.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/form-config/:epcId", asyncHandler(getReportFormConfig));
router.post("/:epcId/submit", uploadReportImages, asyncHandler(submitReport));
router.patch(
  "/:epcId/resubmit",
  uploadReportImages,
  asyncHandler(resubmitReport),
);
router.get("/:epcId", asyncHandler(getReport));
router.post("/:reportId/validate", asyncHandler(validateReport));
router.post(
  "/:reportId/request-clarification",
  asyncHandler(requestReportClarification),
);

export default router;

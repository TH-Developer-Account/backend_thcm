import { Router } from "express";
import multer from "multer";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  submitReport,
  resubmitReport,
  getReport,
  validateReport,
  requestReportClarification,
} from "../controllers/report.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

// ─────────────────────────────────────────────────────────────────────────────
// MULTER CONFIG
//
// Each image field maps to a fixed position (1–4).
// Named fields make position implicit — no extra body param needed to know
// which slot a file belongs to.
//
// Validation (mime type, size) is handled in the controller so the error
// message can reference the specific position that failed.
// fileFilter here only blocks non-image uploads before they hit memory.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return callback(
        new Error("Only JPEG, PNG, and WebP images are accepted"),
      );
    }
    callback(null, true);
  },
});

// Accepts all 4 named image fields.
// On resubmit, only the positions being replaced need to be sent —
// multer simply won't populate the fields that weren't included.
const imageFields = upload.fields([
  { name: "image_1", maxCount: 1 },
  { name: "image_2", maxCount: 1 },
  { name: "image_3", maxCount: 1 },
  { name: "image_4", maxCount: 1 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
//
// Mounted under /api/v1/report — full paths:
//   POST   /api/v1/report/:epcId/submit
//   POST   /api/v1/report/:epcId/resubmit
//   GET    /api/v1/report/:epcId
//   POST   /api/v1/report/:reportId/validate
//   POST   /api/v1/report/:reportId/clarify
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:epcId/submit", imageFields, asyncHandler(submitReport));
router.post("/:epcId/resubmit", imageFields, asyncHandler(resubmitReport));
router.get("/:epcId", asyncHandler(getReport));
router.post("/:reportId/validate", asyncHandler(validateReport));
router.post("/:reportId/clarify", asyncHandler(requestReportClarification));

export default router;

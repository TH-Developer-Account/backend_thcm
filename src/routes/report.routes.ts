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
  rejectReport,
} from "../controllers/report.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf") {
      return callback(new Error("Only PDF files are accepted"));
    }
    callback(null, true);
  },
});

// Mounted under /api/v1/report — full paths:
//   POST   /api/v1/report/:epcId/submit
//   PATCH  /api/v1/report/:epcId/resubmit
//   GET    /api/v1/report/:epcId
//   POST   /api/v1/report/:reportId/validate
//   POST   /api/v1/report/:reportId/reject

router.post(
  "/:epcId/submit",
  upload.single("file"),
  asyncHandler(submitReport),
);
router.patch(
  "/:epcId/resubmit",
  upload.single("file"),
  asyncHandler(resubmitReport),
);
router.get("/:epcId", asyncHandler(getReport));
router.post("/:reportId/validate", asyncHandler(validateReport));
router.post("/:reportId/reject", asyncHandler(rejectReport));

export default router;

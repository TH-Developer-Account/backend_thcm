import { Router } from "express";
import multer from "multer";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@auth/auth.middleware";
import { enqueueLeadImport, getLeadImportStatus } from "./import.controller";
import { SUPPORTED_MIME_TYPES } from "./utils/fileParser";

const router = Router();

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      return callback(
        new Error("Only JPEG, PNG, and WebP images are accepted"),
      );
    }
    callback(null, true);
  },
});

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/leads", upload.single("file"), asyncHandler(enqueueLeadImport));
router.get("/status/leads", asyncHandler(getLeadImportStatus));

export default router;

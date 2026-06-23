import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  getLeadImportHistory,
  getOutputFileUrl,
  getErrorFileUrl,
} from "../controllers/importExportLog.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/history", asyncHandler(getLeadImportHistory));
router.post("/import-export/:logId/file ", asyncHandler(getOutputFileUrl));
router.post("/import-export/:logId/errors", asyncHandler(getErrorFileUrl));

export default router;

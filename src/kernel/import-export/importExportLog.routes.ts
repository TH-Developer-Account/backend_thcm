import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@auth/auth.middleware";
import {
  getLeadImportHistory,
  getOutputFileUrl,
  getErrorFileUrl,
} from "./importExportLog.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/history", asyncHandler(getLeadImportHistory));
router.post("/import-export/:logId/file ", asyncHandler(getOutputFileUrl));
router.post("/import-export/:logId/errors", asyncHandler(getErrorFileUrl));

export default router;

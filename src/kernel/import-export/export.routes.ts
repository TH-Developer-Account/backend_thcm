import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@kernel/auth/auth.middleware";
import {
  enqueueEpcExport,
  getEpcExportStatus,
  enqueueLeadExport,
  getLeadExportStatus,
} from "./export.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/epc", asyncHandler(enqueueEpcExport));
router.get("/status/epc", asyncHandler(getEpcExportStatus));
router.post("/lead", asyncHandler(enqueueLeadExport));
router.get("/status/lead", asyncHandler(getLeadExportStatus));

export default router;

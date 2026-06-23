import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  enqueueEpcExport,
  getEpcExportStatus,
  enqueueLeadExport,
  getLeadExportStatus,
} from "../controllers/export.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/epc", asyncHandler(enqueueEpcExport));
router.get("/status/epc", asyncHandler(getEpcExportStatus));
router.post("/lead", asyncHandler(enqueueLeadExport));
router.get("/status/lead", asyncHandler(getLeadExportStatus));

export default router;

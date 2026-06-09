import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  enqueueLeadImport,
  getLeadImportStatus,
} from "../controllers/import.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/lead", asyncHandler(enqueueLeadImport));
router.get("/status/lead", asyncHandler(getLeadImportStatus));

export default router;

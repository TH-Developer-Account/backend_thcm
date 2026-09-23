import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth, authorize } from "@auth/auth.middleware";
import { getCRFById, updateCRF, createCRF } from "@map/crf.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

// router.post(
//   "/",
//   authorize("MAP", "Event Proposal Form", "write"),
//   asyncHandler(createEPCController),
// );
router.post("/", asyncHandler(createCRF));
router.get("/:crfId", asyncHandler(getCRFById));
router.put("/:crfId", asyncHandler(updateCRF));

export default router;

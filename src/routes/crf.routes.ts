import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  getCRFById,
  updateCRF,
  createCRF,
} from "../controllers/crf.controller";

const router = Router();

// router.use(requireAuth); // sets req.user
// router.use(firstAuthRequestPerDay);

// router.post(
//   "/",
//   authorize("MAP", "Event Proposal Form", "write"),
//   asyncHandler(createEPCController),
// );
router.post("/", asyncHandler(createCRF));
router.get("/:crfId", asyncHandler(getCRFById));
router.put("/:crfId", asyncHandler(updateCRF));

export default router;

import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth } from "@auth/auth.middleware";
import { getCRFById, updateCRF, createCRF } from "./crf.controller";
import {
  postCrfOrder,
  postCrfOrderCancel,
  postCrfOrderRetry,
  putCrfDispatchDetails,
  putCrfSouvenirs,
} from "./crf-order.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

// ── Drafting (crf.service.ts) — CRF.status === OPEN ──────────────────────
router.post("/", asyncHandler(createCRF));
router.get("/:crfId", asyncHandler(getCRFById));
router.put("/:crfId", asyncHandler(updateCRF));

// ── Post-approval (crfDispatchDetails.service.ts / crfOrder.service.ts) ──
// Registered after the two above so a literal path (e.g. "/:crfId/order")
// is matched as its own route, not swallowed by "/:crfId" — Express tries
// routes in registration order and only a path with the extra segment
// reaches these.
router.put("/:crfId/dispatch-details", asyncHandler(putCrfDispatchDetails));
router.put("/:crfId/souvenirs", asyncHandler(putCrfSouvenirs));
router.post("/:crfId/order", asyncHandler(postCrfOrder));
router.post("/:crfId/order/retry", asyncHandler(postCrfOrderRetry));
router.post("/:crfId/order/cancel", asyncHandler(postCrfOrderCancel));

export default router;

import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth, authorize } from "@auth/auth.middleware";
import {
  createEventProposal,
  getAllEventProposals,
  getEventProposalById,
  updateEventProposal,
  deleteEventProposal,
  updateEventProposalOutcome,
  closeEpc,
  initiateDeviation,
  getAuthorityEligibility,
  checkAuthorityForAmount,
  finalizeEventProposal,
} from "./epc.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/",
  authorize("MAP", "EPC", "write"),
  asyncHandler(createEventProposal),
);
router.get("/", asyncHandler(getAllEventProposals));
// Must be registered BEFORE GET /:id — otherwise "authority-check" would be
// swallowed as an :id value and never reach this handler. This is the
// EPC-agnostic, pre-save authority check (see epc.controller.ts); the
// per-EPC version lives at GET /:id/authority-check below.
router.get("/authority-check", asyncHandler(checkAuthorityForAmount));
router.get("/:id", asyncHandler(getEventProposalById));
router.put("/:id", asyncHandler(updateEventProposal));
router.delete("/:id", asyncHandler(deleteEventProposal));
router.patch("/:id/event-outcome", asyncHandler(updateEventProposalOutcome));
router.patch("/:id/close", asyncHandler(closeEpc));
router.get("/:id/authority-check", asyncHandler(getAuthorityEligibility));
router.post(
  "/:id/finalize",
  authorize("MAP", "EPC", "write"),
  asyncHandler(finalizeEventProposal),
);
router.post(
  "/:id/initiate-deviation",
  upload.single("file"),
  asyncHandler(initiateDeviation),
);

export default router;

import { Router } from "express";
import multer from "multer";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  createEventProposal,
  getAllEventProposals,
  getEventProposalById,
  updateEventProposal,
  deleteEventProposal,
  updateEventProposalOutcome,
  closeEpc,
  initiateDeviation,
} from "../controllers/epc.controller";

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
router.get("/:id", asyncHandler(getEventProposalById));
router.put("/:id", asyncHandler(updateEventProposal));
router.delete("/:id", asyncHandler(deleteEventProposal));
router.patch("/:id/event-outcome", asyncHandler(updateEventProposalOutcome));
router.patch("/:id/close", asyncHandler(closeEpc));
router.post(
  "/:id/initiate-deviation",
  upload.single("file"),
  asyncHandler(initiateDeviation),
);

export default router;

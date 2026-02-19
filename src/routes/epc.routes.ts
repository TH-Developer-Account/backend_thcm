import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  createEventProposal,
  getAllEventProposals,
  getEventProposalById,
  updateEventProposal,
  deleteEventProposal,
} from "../controllers/epc.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post(
  "/",
  authorize("event", "approval", "create"),
  asyncHandler(createEventProposal),
);
router.get("/", asyncHandler(getAllEventProposals));
router.get("/:id", asyncHandler(getEventProposalById));
router.put("/:id", asyncHandler(updateEventProposal));
router.delete("/:id", asyncHandler(deleteEventProposal));

export default router;

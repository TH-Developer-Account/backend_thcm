import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
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

router.post("/", asyncHandler(createEventProposal));
router.get("/", asyncHandler(getAllEventProposals));
router.get("/:id", asyncHandler(getEventProposalById));
router.put("/:id", asyncHandler(updateEventProposal));
router.delete("/:id", asyncHandler(deleteEventProposal));

export default router;

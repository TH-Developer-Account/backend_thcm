import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth, authorize } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import {
  getEPFById,
  updateEPF,
  createEPF,
} from "../controllers/epf.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/", asyncHandler(createEPF));
router.get("/:epfId", asyncHandler(getEPFById));
router.put("/:epfId", asyncHandler(updateEPF));

export default router;

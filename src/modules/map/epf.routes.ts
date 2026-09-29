import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, authorize } from "@auth/auth.middleware";
import { getEPFById, updateEPF, createEPF } from "@map/epf.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.post("/", asyncHandler(createEPF));
router.get("/:epfId", asyncHandler(getEPFById));
router.put("/:epfId", asyncHandler(updateEPF));

export default router;

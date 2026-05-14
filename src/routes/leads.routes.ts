import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { firstAuthRequestPerDay } from "../middleware/dailyActiveUsers.middleware";
import { createLeads, getLeads } from "../controllers/leads.controller";

const router = Router();

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

router.post("/create-leads", asyncHandler(createLeads));
router.get("/get-all-leads", asyncHandler(getLeads));

export default router;

import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@auth/auth.middleware";
import { internalAuth } from "@auth/internalAuth.middleware";
import { createLeads, getLeads, getLeadsByPhone } from "./leads.controller";

const router = Router();

router.get("/get-lead-by-phone", internalAuth, asyncHandler(getLeadsByPhone));

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

router.post("/create-leads", asyncHandler(createLeads));
router.get("/get-all-leads", asyncHandler(getLeads));

export default router;

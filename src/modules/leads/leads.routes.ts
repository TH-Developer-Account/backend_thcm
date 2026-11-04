import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth } from "@auth/auth.middleware";
import { internalAuth } from "@auth/internalAuth.middleware";
import {
  createLeads,
  getLeads,
  getLeadsByEpc,
  getLeadFormConfig,
  getLeadById,
  updateLead,
  deleteLead,
  getLeadsByPhone,
} from "./leads.controller";

const router = Router();

router.get("/get-lead-by-phone", internalAuth, asyncHandler(getLeadsByPhone));

router.use(requireAuth);
router.use(firstAuthRequestPerDay);

router.post("/create-leads", asyncHandler(createLeads));
router.get("/get-all-leads", asyncHandler(getLeads));

// Specific paths before the generic /:leadId — otherwise Express matches
// "form-config" or "epc" as a leadId value.
router.get("/form-config/:epcId", asyncHandler(getLeadFormConfig));
router.get("/epc/:epcId", asyncHandler(getLeadsByEpc));

router.get("/:leadId", asyncHandler(getLeadById));
router.put("/:leadId", asyncHandler(updateLead));
router.delete("/:leadId", asyncHandler(deleteLead));

export default router;

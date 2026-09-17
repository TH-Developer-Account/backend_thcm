import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import {
  // ── Templates (Admin) ──
  createChecklistTemplate,
  listChecklistTemplates,
  getChecklistTemplateById,
  updateChecklistTemplateDraft,
  createTemplateDraftVersion,
  publishChecklistTemplate,

  // ── Cycles (Admin, read-only for now — scheduler wiring comes later) ──
  // Removed — see note in dealerAudit.service.ts on why DealerAuditCycle
  // itself was collapsed; nothing left to list.

  // ── Internal staff surface: Admin/Reviewer view any instance, Reviewer acts ──
  triggerDealerAuditInstance,
  listDealerAuditInstances,
  getDealerAuditInstanceById,
  setDealerAuditReviewerNotes,
  setDealerAuditReviewStatus,

  // ── Dealer surface: own instances only ──
  listMyDealerAuditInstances,
  getMyDealerAuditInstanceById,
  saveMyDealerAuditResponses,
  submitMyDealerAuditInstance,
  resubmitMyDealerAuditInstance,
  uploadMyDealerAuditItemEvidence,
} from "./dealerAudit.controller";

const router = Router();
export const APP_KEY = "DEALER_AUDIT";
const MODULE_ADMIN = "DEALER_AUDIT_ADMIN";
const MODULE_REVIEW = "DEALER_AUDIT_REVIEW";
const MODULE_DEALER = "DEALER_AUDIT_DEALER";

const upload = multer({ storage: multer.memoryStorage() });

// ── Dealer surface (own instances only) ──
//
// Two checks now, not one: authorize() gates "does this user hold Dealer
// access at all" (revocable independently of any row they happen to own),
// and the controller's ownership check (dealerUserId === req.user.id)
// gates "is this specific instance theirs." Neither replaces the other —
// losing the module grant locks a former dealer out completely regardless
// of what they still own; the ownership check stops one dealer from ever
// reaching another dealer's rows regardless of module access.

router.get(
  "/mine",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "read"),
  asyncHandler(listMyDealerAuditInstances),
);
router.get(
  "/mine/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "read"),
  asyncHandler(getMyDealerAuditInstanceById),
);
router.patch(
  "/mine/:id/responses",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "write"),
  asyncHandler(saveMyDealerAuditResponses),
);
router.post(
  "/mine/:id/submit",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "write"),
  asyncHandler(submitMyDealerAuditInstance),
);
router.post(
  "/mine/:id/resubmit",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "write"),
  asyncHandler(resubmitMyDealerAuditInstance),
);
router.post(
  "/mine/:id/items/:itemId/evidence",
  requireAuth,
  authorize(APP_KEY, MODULE_DEALER, "write"),
  upload.array("files"),
  asyncHandler(uploadMyDealerAuditItemEvidence),
);

// ── Internal staff surface ──
// Admin: templates, cycles, and instance listing/viewing.
// Reviewer: the two review-action routes, plus a read grant on
// DEALER_AUDIT_ADMIN (seeded separately) so they can view the instances
// they're reviewing — authorize() only checks one module per call, so
// that cross-need is handled via the Reviewer profile's permissions,
// not by this route accepting two modules.

router.post(
  "/templates",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(createChecklistTemplate),
);
router.get(
  "/templates",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(listChecklistTemplates),
);
router.get(
  "/templates/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getChecklistTemplateById),
);
router.patch(
  "/templates/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(updateChecklistTemplateDraft),
);
router.post(
  "/templates/:id/new-draft",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(createTemplateDraftVersion),
);
router.post(
  "/templates/:id/publish",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(publishChecklistTemplate),
);

router.post(
  "/instances",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(triggerDealerAuditInstance),
);
router.get(
  "/instances",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(listDealerAuditInstances),
);
router.get(
  "/instances/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getDealerAuditInstanceById),
);
router.patch(
  "/instances/:id/reviewer-notes",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(setDealerAuditReviewerNotes),
);
router.patch(
  "/instances/:id/review-status",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(setDealerAuditReviewStatus),
);

// No approve/reject/clarify routes here — those go through the existing
// generic workflow routes (mounted at /api/v1/soa) with
// subjectType: "DEALER_AUDIT_INSTANCE", same as MEDICAL_CLAIM today.

export default router;

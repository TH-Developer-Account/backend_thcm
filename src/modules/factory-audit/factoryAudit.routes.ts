import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, authorize } from "@kernel/auth/auth.middleware";
import {
  // ── Templates (Admin) ──
  createFactoryAuditTemplate,
  listFactoryAuditTemplates,
  getFactoryAuditTemplateById,
  updateFactoryAuditTemplateDraft,
  createFactoryAuditTemplateDraftVersion,
  publishFactoryAuditTemplate,

  // ── Instance scheduling + listing (Admin) ──
  scheduleFactoryAuditInstance,
  listFactoryAuditInstances,
  getFactoryAuditInstanceById,

  // ── Auditor surface: own assignment only ──
  saveFactoryAuditCheckpointScores,
  submitFactoryAuditAssignment,
  reviseFactoryAuditCheckpointScore,

  // ── Reviewer surface ──
  getFactoryAuditRoundProgress,
  getFactoryAuditRoundScoreComparison,
  finalizeFactoryAuditRoundScoring,
  submitFactoryAuditForApproval,
  flagFactoryAuditCheckpointForImprovement,
  unflagFactoryAuditCheckpoint,
  reopenFactoryAuditInstance,
  createFactoryAuditSubAudit,
} from "./factoryAudit.controller";

const router = Router();
export const APP_KEY = "FACTORY_AUDIT";
const MODULE_ADMIN = "FACTORY_AUDIT_ADMIN";
const MODULE_AUDITOR = "FACTORY_AUDIT_AUDITOR";
const MODULE_REVIEW = "FACTORY_AUDIT_REVIEW";

// ── Templates (Admin) ──

router.post(
  "/templates",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(createFactoryAuditTemplate),
);
router.get(
  "/templates",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(listFactoryAuditTemplates),
);
router.get(
  "/templates/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getFactoryAuditTemplateById),
);
router.patch(
  "/templates/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(updateFactoryAuditTemplateDraft),
);
router.post(
  "/templates/:id/new-draft",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(createFactoryAuditTemplateDraftVersion),
);
router.post(
  "/templates/:id/publish",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(publishFactoryAuditTemplate),
);

// ── Instance scheduling + listing (Admin) ──

router.post(
  "/instances",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "write"),
  asyncHandler(scheduleFactoryAuditInstance),
);
router.get(
  "/instances",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(listFactoryAuditInstances),
);
router.get(
  "/instances/:id",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getFactoryAuditInstanceById),
);

// ── Auditor surface (own assignment only) ──
//
// Ownership is enforced inside the service (getOwnAssignmentOrThrow) —
// authorize() here only gates "does this user hold Factory Audit auditor
// access at all," same two-layer pattern Dealer Audit's "mine" routes use.

router.patch(
  "/assignments/:assignmentId/scores",
  requireAuth,
  authorize(APP_KEY, MODULE_AUDITOR, "write"),
  asyncHandler(saveFactoryAuditCheckpointScores),
);
router.post(
  "/assignments/:assignmentId/submit",
  requireAuth,
  authorize(APP_KEY, MODULE_AUDITOR, "write"),
  asyncHandler(submitFactoryAuditAssignment),
);
router.patch(
  "/assignments/:assignmentId/revise",
  requireAuth,
  authorize(APP_KEY, MODULE_AUDITOR, "write"),
  asyncHandler(reviseFactoryAuditCheckpointScore),
);

// ── Reviewer surface ──

router.get(
  "/instances/:id/progress",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getFactoryAuditRoundProgress),
);
router.get(
  "/instances/:id/comparison",
  requireAuth,
  authorize(APP_KEY, MODULE_ADMIN, "read"),
  asyncHandler(getFactoryAuditRoundScoreComparison),
);
router.post(
  "/instances/:id/finalize",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(finalizeFactoryAuditRoundScoring),
);
router.post(
  "/instances/:id/submit-for-approval",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(submitFactoryAuditForApproval),
);
router.patch(
  "/instances/:id/checkpoints/:checkpointId/flag",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(flagFactoryAuditCheckpointForImprovement),
);
router.delete(
  "/instances/:id/checkpoints/:checkpointId/flag",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(unflagFactoryAuditCheckpoint),
);
router.post(
  "/instances/:id/reopen",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(reopenFactoryAuditInstance),
);
router.post(
  "/instances/:id/sub-audit",
  requireAuth,
  authorize(APP_KEY, MODULE_REVIEW, "write"),
  asyncHandler(createFactoryAuditSubAudit),
);

// No approve/reject/clarify routes here — those go through the existing
// generic workflow routes, same as DEALER_AUDIT_INSTANCE and MEDICAL_CLAIM,
// with subjectType: "FACTORY_AUDIT_INSTANCE".

export default router;

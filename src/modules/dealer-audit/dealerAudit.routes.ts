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
	archiveChecklistTemplate,
	deleteChecklistTemplate,
	uploadChecklistReferencePhoto,

	// ── Internal staff surface: Admin views any instance, Reviewer acts ──
	triggerDealerAuditInstance,
	listDealerAuditInstances,
	getDealerAuditInstanceById,
	generateAndSendDealerAuditReport,
} from "./dealerAudit.controller";
import {
	// ── Audit cycles (Admin): launch + the option lists its wizard needs ──
	launchDealerAuditCycle,
	listReviewerOptions,
	listDealerOptions,
} from "./dealerAuditCycle.controller";
import {
	// ── Audit reads, scoped per role inside the service ──
	listAudits,
	getAudit,
	getChecklist,
	getHistory,
	getReport,
	getTrackerSummary,
	getReviewQueueCounts,
} from "./dealerAuditRead.service";
import {
	saveItem,
	uploadEvidence,
	deleteEvidence,
	submitAudit,
	respondToClarification,
	startReview,
	reviewItem,
	raiseClarification,
	submitReview,
	approveAudit,
	rejectAudit,
	generateReport,
	sendForApproval,
	remindAudits,
	resendReport,
	reassignReviewer,
	createReAudit,
} from "./dealerAuditWrite.service";

const router = Router();
export const APP_KEY = "DEALER_AUDIT";
const MODULE_ADMIN = "DEALER_AUDIT_ADMIN";
const MODULE_REVIEW = "DEALER_AUDIT_REVIEW";
const MODULE_DEALER = "DEALER_AUDIT_DEALER";

const upload = multer({ storage: multer.memoryStorage() });

// ── Audits (all roles) ──
// No authorize() here: which module applies depends on the user, and
// authorize() checks only one. The service resolves the user's scope, returns
// 403 without a grant and 404 for audits outside that scope.
router.get("/tracker/summary", requireAuth, asyncHandler(getTrackerSummary));
router.get(
	"/review-queue/counts",
	requireAuth,
	asyncHandler(getReviewQueueCounts),
);
// Admin (write) or the assigned reviewer; checked in the service.
router.post("/audits/remind", requireAuth, asyncHandler(remindAudits));
router.post(
	"/audits/:id/report/resend",
	requireAuth,
	asyncHandler(resendReport),
);
router.post(
	"/audits/:id/reassign",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(reassignReviewer),
);
router.post(
	"/audits/:id/re-audit",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(createReAudit),
);
router.get("/audits", requireAuth, asyncHandler(listAudits));
router.get("/audits/:id", requireAuth, asyncHandler(getAudit));
router.get("/audits/:id/checklist", requireAuth, asyncHandler(getChecklist));
router.get("/audits/:id/history", requireAuth, asyncHandler(getHistory));
router.get("/audits/:id/report", requireAuth, asyncHandler(getReport));

// ── Audit writes ──
// Dealer and reviewer routes need the module grant here; the service then
// checks ownership/assignment. Approve and reject are open to whoever the
// workflow lists on the current stage.
router.put(
	"/audits/:id/items/:itemId",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "write"),
	asyncHandler(saveItem),
);
router.post(
	"/audits/:id/evidence",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "write"),
	upload.single("file"),
	asyncHandler(uploadEvidence),
);
router.delete(
	"/audits/:id/evidence/:evidenceId",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "write"),
	asyncHandler(deleteEvidence),
);
router.post(
	"/audits/:id/submit",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "write"),
	asyncHandler(submitAudit),
);
router.post(
	"/audits/:id/clarifications/respond",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "write"),
	asyncHandler(respondToClarification),
);
router.post(
	"/audits/:id/review/start",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(startReview),
);
router.put(
	"/audits/:id/items/:itemId/review",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(reviewItem),
);
router.post(
	"/audits/:id/clarifications",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(raiseClarification),
);
router.post(
	"/audits/:id/review/submit",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(submitReview),
);
router.post(
	"/audits/:id/report/generate",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(generateReport),
);
router.post(
	"/audits/:id/send-for-approval",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(sendForApproval),
);
router.post(
	"/audits/:id/approve",
	requireAuth,
	asyncHandler(approveAudit),
);
router.post(
	"/audits/:id/reject",
	requireAuth,
	asyncHandler(rejectAudit),
);

// ── Admin surface ──
// Everything below needs the admin WRITE grant. Reviewers hold only the admin
// read grant, so they cannot reach checklists or unscoped instance lists; they
// read their audits through /audits above.

// ── Audit cycles ──
// One POST creates the cycle and every dealer's audit in one transaction.
// The option lists feed the wizard's "Select dealers" / "Assign reviewers"
// steps.
router.post(
	"/cycles",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(launchDealerAuditCycle),
);
router.get(
	"/options/reviewers",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(listReviewerOptions),
);
router.get(
	"/options/dealers",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(listDealerOptions),
);

// ── Checklist templates ──
router.post(
	"/templates/reference-photos",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	upload.single("file"),
	asyncHandler(uploadChecklistReferencePhoto),
);
router.post(
	"/templates",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(createChecklistTemplate),
);
router.get(
	"/templates",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(listChecklistTemplates),
);
router.get(
	"/templates/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(getChecklistTemplateById),
);
router.patch(
	"/templates/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(updateChecklistTemplateDraft),
);
router.delete(
	"/templates/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(deleteChecklistTemplate),
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
	"/templates/:id/archive",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(archiveChecklistTemplate),
);

// ── Older instance routes ──
router.post(
	"/instances",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(triggerDealerAuditInstance),
);
router.get(
	"/instances",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(listDealerAuditInstances),
);
router.get(
	"/instances/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(getDealerAuditInstanceById),
);
router.post(
	"/instances/:id/report",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(generateAndSendDealerAuditReport),
);

// Sending an audit back to the reviewer (clarify) uses the generic workflow
// routes at /api/v1/soa with subjectType "DEALER_AUDIT_INSTANCE".

export default router;

import { Router, Request, Response, NextFunction } from "express";
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

	// ── Internal staff surface: Admin/Reviewer view any instance, Reviewer acts ──
	triggerDealerAuditInstance,
	listDealerAuditInstances,
	getDealerAuditInstanceById,
	setDealerAuditReviewerNotes,
	setDealerAuditReviewStatus,
	generateAndSendDealerAuditReport,

	// ── Dealer surface: own instances only ──
	getMyDealerAuditInstanceById,
	saveMyDealerAuditResponses,
	submitMyDealerAuditInstance,
	resubmitMyDealerAuditInstance,
	uploadMyDealerAuditItemEvidence,
} from "./dealerAudit.controller";
import {
	// ── Audit cycles (Admin): launch + the option lists its wizard needs ──
	launchDealerAuditCycle,
	listReviewerOptions,
	listDealerOptions,
	// ── Audit list + tracker ──
	listAudits,
	listMyAudits,
	getTrackerSummary,
	// ── One audit ──
	getAudit,
	getAuditChecklist,
} from "./dealerAuditCycle.controller";
import { isDealerUser } from "./dealerAuditCycle.service";

const router = Router();
export const APP_KEY = "DEALER_AUDIT";
const MODULE_ADMIN = "DEALER_AUDIT_ADMIN";
const MODULE_REVIEW = "DEALER_AUDIT_REVIEW";
const MODULE_DEALER = "DEALER_AUDIT_DEALER";

const upload = multer({ storage: multer.memoryStorage() });

// Lets one URL serve two audiences: a dealer login continues on this route,
// everyone else skips to the next matching route.
const dealerOnly = asyncHandler(
	async (req: Request, _res: Response, next: NextFunction) => {
		const isDealer = req.user?.id ? await isDealerUser(req.user.id) : false;
		next(isDealer ? undefined : "route");
	},
);

// ── Dealer surface (own instances only) ──
//
// Two checks now, not one: authorize() gates "does this user hold Dealer
// access at all" (revocable independently of any row they happen to own),
// and the service-layer ownership check (req.user's businessPartnerId
// against the instance's — see getOwnInstanceOrThrow /
// getOwnInstanceForEditOrThrow in dealerAudit.service.ts) gates "is this
// specific instance their dealership's, and are they that dealership's
// primary contact if the action writes." Neither replaces the other —
// losing the module grant locks a former dealer out completely regardless
// of what their dealership still owns; the ownership check stops one
// dealership from ever reaching another's rows regardless of module access.

router.get(
	"/mine",
	requireAuth,
	authorize(APP_KEY, MODULE_DEALER, "read"),
	asyncHandler(listMyAudits),
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

// ── Audit list (shared URL) ──
// Dealer logins only ever get their own dealership's audits, even if their
// profile was given admin access by mistake. Order matters.
router.get(
	"/audits",
	requireAuth,
	dealerOnly,
	authorize(APP_KEY, MODULE_DEALER, "read"),
	asyncHandler(listMyAudits),
);
router.get(
	"/audits",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(listAudits),
);
router.get(
	"/audits/:id",
	requireAuth,
	dealerOnly,
	authorize(APP_KEY, MODULE_DEALER, "read"),
	asyncHandler(getAudit),
);
router.get(
	"/audits/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(getAudit),
);
router.get(
	"/audits/:id/checklist",
	requireAuth,
	dealerOnly,
	authorize(APP_KEY, MODULE_DEALER, "read"),
	asyncHandler(getAuditChecklist),
);
router.get(
	"/audits/:id/checklist",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(getAuditChecklist),
);
router.get(
	"/tracker/summary",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(getTrackerSummary),
);

// ── Internal staff surface ──
// Admin: templates, cycles, and instance listing/viewing.
// Reviewer: the two review-action routes, plus a read grant on
// DEALER_AUDIT_ADMIN (seeded separately) so they can view the instances
// they're reviewing — authorize() only checks one module per call, so
// that cross-need is handled via the Reviewer profile's permissions,
// not by this route accepting two modules.

// ── Audit cycles (Admin) ──
// One POST creates the cycle and every dealer's audit in one transaction.
// The option lists feed the wizard's "Select dealers" / "Assign reviewers"
// steps; both are read-only and need the admin read grant.
router.post(
	"/cycles",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(launchDealerAuditCycle),
);
router.get(
	"/options/reviewers",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(listReviewerOptions),
);
router.get(
	"/options/dealers",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "read"),
	asyncHandler(listDealerOptions),
);

// ── Templates (Admin) ──
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
	"/templates/:id/archive",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(archiveChecklistTemplate),
);
router.delete(
	"/templates/:id",
	requireAuth,
	authorize(APP_KEY, MODULE_ADMIN, "write"),
	asyncHandler(deleteChecklistTemplate),
);

// ── Instances ──
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
router.post(
	"/instances/:id/report",
	requireAuth,
	authorize(APP_KEY, MODULE_REVIEW, "write"),
	asyncHandler(generateAndSendDealerAuditReport),
);

// No approve/reject/clarify routes here — those go through the existing
// generic workflow routes (mounted at /api/v1/soa) with
// subjectType: "DEALER_AUDIT_INSTANCE", same as MEDICAL_CLAIM today.

export default router;

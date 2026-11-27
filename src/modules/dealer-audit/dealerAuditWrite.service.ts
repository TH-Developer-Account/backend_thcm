// Dealer Audit: write APIs (dealer self-assessment, reviewer, approval).
//
// Flow:
//   DRAFT -> IN_PROGRESS -> SUBMITTED -> UNDER_REVIEW
//     -> (CLARIFICATION_REQUIRED -> RESUBMITTED -> UNDER_REVIEW, once)
//     -> PENDING_APPROVAL -> APPROVED / REJECTED
// Deadline fallbacks live in dealerAuditDeadline.job.ts.
//
// Every status change is a conditional update on the current status, so two
// people (or the nightly job) can never both move the same audit.

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import { hasModulePermission } from "@rbac/profile/accessPolicy";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";
import {
	assignWorkflow,
	notifyStageApprovers,
	activateFirstStageForResubmit,
	approveStage,
	rejectStage,
} from "@kernel/workflow/workflow.service";
import {
	getActiveWorkflowForSubject,
	getCurrentStageApprovalOrThrow,
	getResubmitAction,
	getResubmitStatus,
} from "@kernel/workflow/workflowSubject.helper";
import { Prisma } from "../../prisma/generated/prisma/client";
import {
	AUDIT_STATUS,
	AuditStatus,
	FINISHED_AUDIT_STATUSES,
	listReviewerOptions,
} from "./dealerAuditCycle.service";
import { createReportPdf, sendReportMail } from "./dealerAuditReport.service";
import {
	Scope,
	resolveScope,
	loadAuditOrThrow,
	latestPerItem,
	isAnswered,
	buildAudit,
	buildChecklist,
	toListItem,
	isReviewSubmitted,
	currentReportTime,
	REPORT_STATUSES,
	requiredPhotos,
} from "./dealerAuditRead.service";
import { notifyDealer, notifyReviewer } from "./dealerAuditDeadline.job";

const SUBJECT_TYPE = "DEALER_AUDIT_INSTANCE" as const;
const CLARIFICATION_DAYS = 7;
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 2000;
// Reviewer may lower a score by more than this only after one clarification.
const DROP_WITHOUT_CLARIFICATION = 1;

const DEALER_EDITABLE: string[] = [
	AUDIT_STATUS.DRAFT,
	AUDIT_STATUS.IN_PROGRESS,
];
const REVIEWABLE: string[] = [AUDIT_STATUS.UNDER_REVIEW];

type Audit = Awaited<ReturnType<typeof loadAuditOrThrow>>;
type Item = Audit["template"]["items"][number];
type Tx = Prisma.TransactionClient;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const param = (req: Request, name: string) => req.params[name] as string;

function text(value: unknown, field: string) {
	const result = typeof value === "string" ? value.trim() : "";
	if (result.length > MAX_TEXT) {
		throw new ApiError(400, `${field} must be ${MAX_TEXT} characters or fewer`);
	}
	return result;
}

function itemOrThrow(audit: Audit, itemId: string) {
	const item = audit.template.items.find((i) => i.id === itemId);
	if (!item) throw new ApiError(404, "This parameter is not part of the audit");
	return item;
}

function assertScore(item: Item, score: unknown): number | null {
	if (score === null || score === undefined) return null;
	if (!item.requiresScore) {
		throw new ApiError(400, `"${item.label}" is not scored`);
	}
	const levels = Array.isArray(item.scoreLevels)
		? (item.scoreLevels as unknown as { score: number }[]).map((l) => l.score)
		: [];
	const valid =
		typeof score === "number" &&
		(levels.length
			? levels.includes(score)
			: score >= 0 && score <= (item.maxScore ?? 0));
	if (!valid) {
		throw new ApiError(400, `Choose a listed score for "${item.label}"`);
	}
	return score as number;
}

async function move(
	tx: Tx,
	auditId: string,
	from: string[],
	data: Prisma.DealerAuditInstanceUncheckedUpdateManyInput & {
		status: AuditStatus;
	},
) {
	const result = await tx.dealerAuditInstance.updateMany({
		where: { id: auditId, status: { in: from } },
		data,
	});
	if (result.count !== 1) {
		throw new ApiError(409, "This audit has changed. Reload and try again.");
	}
}

const log = (
	tx: Tx,
	actorId: string,
	action: string,
	auditId: string,
	metadata?: Prisma.InputJsonValue,
) =>
	tx.activityLog.create({
		data: {
			actorId,
			action,
			subjectType: SUBJECT_TYPE,
			subjectId: auditId,
			metadata,
		},
	});

const ok = (res: Response, data: unknown) =>
	res.status(200).json({ success: true, data });

// ── Dealer access ──
// Any user of the dealership may fill the audit. Submitting is limited to the
// primary contact. The route has already checked the DEALER write grant.

async function dealerContext(req: Request) {
	const actor = getAuthenticatedUser(req);
	const user = await prisma.user.findUnique({
		where: { id: actor.id },
		select: { businessPartnerId: true, userType: true, isDefaultContact: true },
	});
	if (user?.userType !== "DEALER" || !user.businessPartnerId) {
		throw new ApiError(403, "Only the dealership can do this");
	}
	const scope: Scope = {
		kind: "DEALER",
		businessPartnerId: user.businessPartnerId,
	};
	const audit = await loadAuditOrThrow(scope, param(req, "id"));
	return {
		userId: actor.id,
		isPrimary: user.isDefaultContact,
		scope,
		audit,
	};
}

function assertNotPastDue(audit: Audit) {
	if (audit.dueAt && audit.dueAt.getTime() < Date.now()) {
		throw new ApiError(409, "The due date for this audit has passed");
	}
}

function assertDealerCanEdit(audit: Audit, itemId: string) {
	if (DEALER_EDITABLE.includes(audit.status)) return assertNotPastDue(audit);
	const flagged =
		audit.status === AUDIT_STATUS.CLARIFICATION_REQUIRED &&
		latestPerItem(audit.responses).get(itemId)?.reviewStatus ===
			"CLARIFICATION_REQUESTED";
	if (!flagged)
		throw new ApiError(409, "This parameter can no longer be changed");
}

const photoCount = (tx: Tx, auditId: string, itemId: string) =>
	tx.evidence.count({
		where: { auditItemResponse: { auditInstanceId: auditId, itemId } },
	});

// Current response row for an item, created on first use.
async function currentResponse(
	tx: Tx,
	audit: Audit,
	itemId: string,
	userId: string,
) {
	const existing = latestPerItem(audit.responses).get(itemId);
	if (existing) return existing;
	return tx.auditItemResponse.upsert({
		where: {
			auditInstanceId_itemId_iteration: {
				auditInstanceId: audit.id,
				itemId,
				iteration: 1,
			},
		},
		update: {},
		create: {
			auditInstanceId: audit.id,
			itemId,
			iteration: 1,
			respondedByUserId: userId,
		},
	});
}

async function itemResult(scope: Scope, auditId: string, itemId: string) {
	const [checklist, audit] = await Promise.all([
		buildChecklist(scope, auditId),
		loadAuditOrThrow(scope, auditId),
	]);
	const item = (
		checklist.sections.flatMap((s) => s.items) as { id: string }[]
	).find((i) => i.id === itemId);
	const summary = toListItem(audit, scope);
	return {
		item,
		audit_status: audit.status,
		audit_version: 1,
		completed_items: summary.completed_items,
		total_items: summary.total_items,
	};
}

// ─────────────────────────────────────────────
// Dealer: save, photos, submit, clarification
// ─────────────────────────────────────────────

export async function saveItem(req: Request, res: Response) {
	const { userId, scope, audit } = await dealerContext(req);
	const item = itemOrThrow(audit, param(req, "itemId"));
	if (!DEALER_EDITABLE.includes(audit.status)) {
		throw new ApiError(409, "This audit has already been submitted");
	}
	assertNotPastDue(audit);

	const score = assertScore(item, req.body?.score);
	const remark = text(req.body?.remarks, "Remarks");

	await prisma.$transaction(async (tx) => {
		if (req.body?.mark_complete) {
			if (item.requiresScore ? score === null : !remark) {
				throw new ApiError(
					400,
					item.requiresScore ? "Select a score" : "Add your remarks",
				);
			}
			const needed = requiredPhotos(item);
			if ((await photoCount(tx, audit.id, item.id)) < needed) {
				throw new ApiError(400, `Add at least ${needed} photo(s)`);
			}
		}
		const response = await currentResponse(tx, audit, item.id, userId);
		await tx.auditItemResponse.update({
			where: { id: response.id },
			data: {
				dealerScore: score,
				dealerRemark: remark || null,
				respondedByUserId: userId,
				dealerRespondedAt: new Date(),
			},
		});
		await move(tx, audit.id, DEALER_EDITABLE, {
			status: AUDIT_STATUS.IN_PROGRESS,
		});
	});

	ok(res, await itemResult(scope, audit.id, item.id));
}

const IMAGE_TYPES: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

export async function uploadEvidence(req: Request, res: Response) {
	const { userId, scope, audit } = await dealerContext(req);
	const item = itemOrThrow(audit, String(req.body?.item_id ?? ""));
	assertDealerCanEdit(audit, item.id);

	const file = req.file;
	if (!file) throw new ApiError(400, "A photo is required");
	const ext = IMAGE_TYPES[file.mimetype];
	if (!ext) throw new ApiError(400, "Only JPG, PNG or WebP photos are allowed");
	if (file.size > MAX_PHOTO_BYTES) {
		throw new ApiError(400, "Photo must be 5 MB or smaller");
	}

	const lat = Number.parseFloat(req.body?.latitude);
	const lng = Number.parseFloat(req.body?.longitude);
	if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) {
		throw new ApiError(400, "Location is required. Turn on GPS and retake it.");
	}
	const accuracy = Number.parseFloat(req.body?.accuracy_m);
	const capturedAt = new Date(req.body?.captured_at ?? Date.now());
	if (Number.isNaN(capturedAt.getTime())) {
		throw new ApiError(400, "captured_at is not a valid date");
	}

	const limit = Math.min(item.maxEvidence ?? MAX_PHOTOS, MAX_PHOTOS);
	const assertRoom = async (tx: Tx) => {
		if ((await photoCount(tx, audit.id, item.id)) >= limit) {
			throw new ApiError(409, `Only ${limit} photo(s) are allowed here`);
		}
	};
	await assertRoom(prisma);

	const s3Key = `dealer-audit-evidence/${audit.id}/${item.id}/${randomUUID()}-photo.${ext}`;
	await uploadToS3(s3Key, file.buffer, file.mimetype);
	const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

	const row = await prisma.$transaction(async (tx) => {
		await assertRoom(tx);
		const response = await currentResponse(tx, audit, item.id, userId);
		const created = await tx.evidence.create({
			data: {
				auditItemResponseId: response.id,
				subjectType: "DEALER_ITEM_RESPONSE",
				subjectId: response.id,
				s3Key,
				fileUrl,
				uploadedBy: userId,
				capturedAt,
				geoLat: lat,
				geoLng: lng,
				accuracyMeters: Number.isFinite(accuracy) ? accuracy : null,
			},
		});
		if (audit.status === AUDIT_STATUS.DRAFT) {
			await move(tx, audit.id, [AUDIT_STATUS.DRAFT], {
				status: AUDIT_STATUS.IN_PROGRESS,
			});
		}
		return created;
	});

	const result = await itemResult(scope, audit.id, item.id);
	const photos = (result.item as { self?: { evidence?: { id: string }[] } })
		?.self?.evidence;
	res.status(201).json({
		success: true,
		data: photos?.find((p) => p.id === row.id),
	});
}

export async function deleteEvidence(req: Request, res: Response) {
	const { audit } = await dealerContext(req);
	const row = await prisma.evidence.findFirst({
		where: {
			id: param(req, "evidenceId"),
			auditItemResponse: { auditInstanceId: audit.id },
		},
		include: { auditItemResponse: true },
	});
	if (!row?.auditItemResponse) throw new ApiError(404, "Photo not found");

	const { itemId, id: responseId } = row.auditItemResponse;
	assertDealerCanEdit(audit, itemId);
	// Photos the reviewer has already seen are part of the record. During a
	// clarification only photos added after the review can be removed.
	const latest = latestPerItem(audit.responses).get(itemId);
	const seen =
		audit.status === AUDIT_STATUS.CLARIFICATION_REQUIRED &&
		!!latest?.reviewedAt &&
		row.capturedAt <= latest.reviewedAt;
	if (latest?.id !== responseId || seen) {
		throw new ApiError(409, "Photos already reviewed cannot be removed");
	}
	await prisma.evidence.delete({ where: { id: row.id } });
	ok(res, null);
}

export async function submitAudit(req: Request, res: Response) {
	const { userId, isPrimary, scope, audit } = await dealerContext(req);
	if (!isPrimary) {
		throw new ApiError(
			403,
			"Only your dealership's primary contact can submit the audit",
		);
	}
	if (!DEALER_EDITABLE.includes(audit.status)) {
		throw new ApiError(409, "This audit has already been submitted");
	}
	assertNotPastDue(audit);

	const latest = latestPerItem(audit.responses);
	const missing: string[] = [];
	for (const item of audit.template.items) {
		const response = latest.get(item.id);
		const needed = requiredPhotos(item);
		if (
			!isAnswered(item, response) ||
			(needed && (await photoCount(prisma, audit.id, item.id)) < needed)
		) {
			missing.push(item.label);
		}
	}
	if (missing.length) {
		throw new ApiError(
			422,
			`${missing.length} parameter(s) are incomplete: ${missing.slice(0, 5).join(", ")}`,
		);
	}

	await prisma.$transaction(async (tx) => {
		await move(tx, audit.id, DEALER_EDITABLE, {
			status: AUDIT_STATUS.SUBMITTED,
			submittedAt: new Date(),
			lastReminderAt: null,
		});
		await log(tx, userId, "DEALER_AUDIT_SUBMITTED", audit.id);
	});
	await notifyReviewer(
		audit.id,
		"Audit submitted for review",
		"The dealer has submitted the self-assessment.",
	);

	ok(res, await buildAudit(scope, audit.id));
}

export async function respondToClarification(req: Request, res: Response) {
	const { userId, scope, audit } = await dealerContext(req);
	const item = itemOrThrow(audit, String(req.body?.item_id ?? ""));
	const answer = text(req.body?.response, "Response");
	if (!answer) throw new ApiError(400, "Enter your response");
	assertDealerCanEdit(audit, item.id);
	if (audit.status !== AUDIT_STATUS.CLARIFICATION_REQUIRED) {
		throw new ApiError(409, "No clarification is open for this audit");
	}
	if (audit.clarificationDueAt && audit.clarificationDueAt < new Date()) {
		throw new ApiError(409, "The time to respond has passed");
	}
	const previous = latestPerItem(audit.responses).get(item.id)!;

	const allAnswered = await prisma.$transaction(async (tx) => {
		// A new round keeps the earlier answer and the reviewer's note as history.
		await tx.auditItemResponse.create({
			data: {
				auditInstanceId: audit.id,
				itemId: item.id,
				iteration: previous.iteration + 1,
				isNotApplicable: previous.isNotApplicable,
				dealerScore: previous.dealerScore,
				dealerRemark: answer,
				respondedByUserId: userId,
				dealerRespondedAt: new Date(),
			},
		});
		await log(tx, userId, "DEALER_AUDIT_CLARIFICATION_RESPONDED", audit.id, {
			itemId: item.id,
		});
		const rows = await tx.auditItemResponse.findMany({
			where: { auditInstanceId: audit.id },
		});
		const open = [...latestPerItem(rows).values()].some(
			(r) => r.reviewStatus === "CLARIFICATION_REQUESTED",
		);
		if (!open) {
			await move(tx, audit.id, [AUDIT_STATUS.CLARIFICATION_REQUIRED], {
				status: AUDIT_STATUS.RESUBMITTED,
				clarificationDueAt: null,
				lastReminderAt: null,
			});
		}
		return !open;
	});
	if (allAnswered) {
		await notifyReviewer(
			audit.id,
			"Clarification received",
			"The dealer has answered all clarification points.",
		);
	}

	ok(res, (await itemResult(scope, audit.id, item.id)).item);
}

// ─────────────────────────────────────────────
// Reviewer
// ─────────────────────────────────────────────

// Only the assigned reviewer, whatever else the user can see.
async function reviewerContext(req: Request) {
	const userId = getAuthenticatedUser(req).id;
	const scope: Scope = { kind: "ASSIGNED", userId, approvalIds: [] };
	const audit = await loadAuditOrThrow(scope, param(req, "id"));
	return { userId, scope, audit };
}

export async function startReview(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	if (audit.status !== AUDIT_STATUS.UNDER_REVIEW) {
		await prisma.$transaction(async (tx) => {
			await move(
				tx,
				audit.id,
				[AUDIT_STATUS.SUBMITTED, AUDIT_STATUS.RESUBMITTED],
				{ status: AUDIT_STATUS.UNDER_REVIEW },
			);
			await log(tx, userId, "DEALER_AUDIT_REVIEW_STARTED", audit.id);
		});
	}
	ok(res, await buildAudit(scope, audit.id));
}

function assertReviewOpen(audit: Audit) {
	if (!REVIEWABLE.includes(audit.status)) {
		throw new ApiError(409, "This audit is not under review");
	}
}

export async function reviewItem(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	assertReviewOpen(audit);
	const item = itemOrThrow(audit, param(req, "itemId"));
	const response = latestPerItem(audit.responses).get(item.id);
	if (!response) throw new ApiError(409, "The dealer has not answered this");

	const decision = String(req.body?.decision ?? "PENDING");
	const score = assertScore(item, req.body?.reviewer_score);
	const remarks = text(req.body?.reviewer_remarks, "Remarks");
	const reason = text(req.body?.score_change_reason, "Reason");
	const remark =
		reason && !remarks.includes(reason)
			? [remarks, reason].filter(Boolean).join("\nReason: ")
			: remarks;
	if (decision === "CLARIFICATION_REQUIRED" && hadClarification(audit)) {
		throw new ApiError(409, "Only one clarification round is allowed");
	}
	const lowered =
		score !== null &&
		response.dealerScore !== null &&
		score < response.dealerScore;
	if ((lowered || decision === "CLARIFICATION_REQUIRED") && !remark) {
		throw new ApiError(400, "A remark is required");
	}

	// Any change after "Submit review" means it must be submitted again.
	if (audit.finalScore !== null) {
		await move(prisma, audit.id, REVIEWABLE, {
			status: AUDIT_STATUS.UNDER_REVIEW,
			finalScore: null,
		});
	}
	await prisma.auditItemResponse.update({
		where: { id: response.id },
		data: {
			reviewerScore: score,
			reviewerRemark: remark || null,
			isNotApplicable: decision === "NOT_APPLICABLE",
			reviewStatus:
				decision === "CLARIFICATION_REQUIRED"
					? "CLARIFICATION_REQUESTED"
					: decision === "PENDING"
						? "PENDING"
						: "APPROVED",
			reviewedAt: new Date(),
		},
	});
	await log(prisma, userId, "DEALER_AUDIT_REVIEWER_NOTES_SET", audit.id, {
		itemId: item.id,
	});

	ok(res, await itemResult(scope, audit.id, item.id));
}

const hadClarification = (audit: Audit) =>
	audit.responses.some((r) => r.iteration > 1);

export async function raiseClarification(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	assertReviewOpen(audit);
	if (hadClarification(audit)) {
		throw new ApiError(409, "Only one clarification round is allowed");
	}
	const ids: string[] = Array.isArray(req.body?.item_ids)
		? [...new Set<string>(req.body.item_ids.map(String))]
		: [];
	if (!ids.length) throw new ApiError(400, "Select at least one parameter");
	const remarks = text(req.body?.remarks, "Remarks");
	if (!remarks) throw new ApiError(400, "Remarks are required");
	const latest = latestPerItem(audit.responses);
	const responses = ids.map((id) => {
		itemOrThrow(audit, id);
		const response = latest.get(id);
		if (!response) throw new ApiError(409, "The dealer has not answered this");
		// This score becomes final if the dealer does not respond.
		const item = itemOrThrow(audit, id);
		if (
			item.requiresScore &&
			!response.isNotApplicable &&
			response.reviewerScore === null
		) {
			throw new ApiError(400, `Score "${item.label}" before asking about it`);
		}
		return response;
	});
	const dueAt = new Date(Date.now() + CLARIFICATION_DAYS * 86_400_000);

	await prisma.$transaction(async (tx) => {
		// Flags set on other items but not included are cleared.
		await tx.auditItemResponse.updateMany({
			where: {
				auditInstanceId: audit.id,
				reviewStatus: "CLARIFICATION_REQUESTED",
			},
			data: { reviewStatus: "PENDING" },
		});
		for (const response of responses) {
			await tx.auditItemResponse.update({
				where: { id: response.id },
				data: {
					reviewStatus: "CLARIFICATION_REQUESTED",
					reviewerRemark: response.reviewerRemark || remarks,
					reviewedAt: new Date(),
				},
			});
		}
		await move(tx, audit.id, REVIEWABLE, {
			status: AUDIT_STATUS.CLARIFICATION_REQUIRED,
			clarificationDueAt: dueAt,
			lastReminderAt: null,
			finalScore: null,
		});
		await log(tx, userId, "DEALER_AUDIT_CLARIFICATION_RAISED", audit.id, {
			itemIds: ids,
			reason: remarks,
		});
	});
	await notifyDealer(
		audit.id,
		"Clarification requested",
		`Please respond within ${CLARIFICATION_DAYS} days. If you do not, the reviewer's score becomes final.`,
	);

	ok(res, await buildAudit(scope, audit.id));
}

export async function submitReview(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	assertReviewOpen(audit);
	const latest = latestPerItem(audit.responses);
	const clarified = hadClarification(audit);

	const unreviewed: string[] = [];
	const needsClarification: string[] = [];
	let finalScore = 0;
	let maxScore = 0;
	for (const item of audit.template.items) {
		const response = latest.get(item.id);
		const na = !!response?.isNotApplicable;
		if (item.requiresScore) maxScore += item.maxScore ?? 0;
		if (
			!response ||
			response.reviewStatus === "CLARIFICATION_REQUESTED" ||
			(item.requiresScore
				? !na && response.reviewerScore === null
				: response.reviewStatus !== "APPROVED")
		) {
			unreviewed.push(item.label);
			continue;
		}
		if (!item.requiresScore || na) continue;
		finalScore += response.reviewerScore!;
		if (
			!clarified &&
			(response.dealerScore ?? 0) - response.reviewerScore! >
				DROP_WITHOUT_CLARIFICATION
		) {
			needsClarification.push(item.label);
		}
	}
	if (unreviewed.length) {
		throw new ApiError(
			422,
			`Review these first: ${unreviewed.slice(0, 5).join(", ")}`,
		);
	}
	if (needsClarification.length) {
		throw new ApiError(
			422,
			`Ask for clarification before lowering by more than ${DROP_WITHOUT_CLARIFICATION} point: ${needsClarification.slice(0, 5).join(", ")}`,
		);
	}

	await prisma.$transaction(async (tx) => {
		await tx.auditItemResponse.updateMany({
			where: { id: { in: [...latest.values()].map((r) => r.id) } },
			data: { reviewStatus: "APPROVED" },
		});
		// Status stays UNDER_REVIEW: the reviewer next generates the report and
		// sends it for approval.
		await move(tx, audit.id, REVIEWABLE, {
			status: AUDIT_STATUS.UNDER_REVIEW,
			finalScore,
			maxScore,
		});
		await log(tx, userId, "DEALER_AUDIT_REVIEW_SUBMITTED", audit.id);
	});

	ok(res, await buildAudit(scope, audit.id));
}

function assertReviewSubmitted(audit: Audit) {
	if (!isReviewSubmitted(audit)) {
		throw new ApiError(409, "Submit your review first");
	}
}

export async function generateReport(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	assertReviewSubmitted(audit);
	await createReportPdf(audit.id);
	await log(prisma, userId, "DEALER_AUDIT_REPORT_GENERATED", audit.id);
	ok(res, await buildAudit(scope, audit.id));
}

export async function sendForApproval(req: Request, res: Response) {
	const { userId, scope, audit } = await reviewerContext(req);
	assertReviewSubmitted(audit);
	if (!(await currentReportTime(audit.id))) {
		throw new ApiError(409, "Generate the report before sending for approval");
	}

	const app = await prisma.app.findUnique({ where: { key: "DEALER_AUDIT" } });
	if (!app) throw new ApiError(500, "Dealer Audit app is not registered");
	const active = await getActiveWorkflowForSubject(SUBJECT_TYPE, audit.id);
	// The approval workflow is the template assigned to this reviewer.
	const template = active
		? null
		: await prisma.workflowTemplate.findFirst({
				where: {
					workspaceId: audit.workspaceId,
					appId: app.id,
					isActive: true,
					isReusable: true,
					workFlowUsers: { some: { userId } },
				},
				orderBy: { created_at: "desc" },
				select: { id: true },
			});
	if (!active && !template) {
		throw new ApiError(
			400,
			"No approval workflow is assigned to you. Ask an admin to assign one.",
		);
	}

	const assigned = await prisma.$transaction(async (tx) => {
		await move(tx, audit.id, REVIEWABLE, {
			status: AUDIT_STATUS.PENDING_APPROVAL,
		});
		await log(tx, userId, "DEALER_AUDIT_SENT_FOR_APPROVAL", audit.id);

		// Returned by an approver earlier: reopen the same workflow.
		if (active) {
			const reopened = await activateFirstStageForResubmit(
				tx,
				active.id,
				{ type: "user", id: userId },
				getResubmitAction(SUBJECT_TYPE),
				getResubmitStatus(SUBJECT_TYPE),
			);
			const approvals = await tx.approval.findMany({
				where: { stageId: reopened.firstStageInstanceId },
				select: { approverId: true },
			});
			return {
				workflowId: active.id,
				stageId: reopened.firstStageInstanceId,
				approverIds: approvals.map((a) => a.approverId),
			};
		}
		// The workflow starts here: the reviewer is the proposer.
		const result = await assignWorkflow(tx, {
			subjectType: SUBJECT_TYPE,
			subjectId: audit.id,
			workspaceId: audit.workspaceId,
			appId: app.id,
			userId,
			criteria: { workflowId: template?.id },
		});
		return {
			workflowId: result.workflowInstance.id,
			stageId: result.stageOneId,
			approverIds: result.stageOneApproverIds,
		};
	});

	if (assigned.stageId) {
		await notifyStageApprovers({
			workflowId: assigned.workflowId,
			subjectType: SUBJECT_TYPE,
			subjectId: audit.id,
			appId: app.id,
			stageId: assigned.stageId,
			approverIds: assigned.approverIds,
		});
	}

	ok(res, await buildAudit(scope, audit.id));
}

// ─────────────────────────────────────────────
// Admin / reviewer actions
// ─────────────────────────────────────────────

const MAX_BULK = 500;
const MAX_RECIPIENTS = 10;

// Admins (write) act on any audit, reviewers only on their own. Read-only users
// and dealers are refused.
async function managerScope(req: Request): Promise<Scope> {
	const actor = getAuthenticatedUser(req);
	const scope = await resolveScope(req);
	const can = (moduleKey: string) =>
		hasModulePermission(actor, "write", "DEALER_AUDIT", moduleKey);
	if (scope.kind !== "DEALER") {
		if (can("DEALER_AUDIT_ADMIN")) return { kind: "ALL" };
		if (can("DEALER_AUDIT_REVIEW")) {
			return { kind: "ASSIGNED", userId: actor.id, approvalIds: [] };
		}
	}
	throw new ApiError(403, "You cannot do this");
}

export async function remindAudits(req: Request, res: Response) {
	const scope = await managerScope(req);
	const ids: string[] = Array.isArray(req.body?.audit_ids)
		? [...new Set<string>(req.body.audit_ids.map(String))]
		: [];
	if (!ids.length || ids.length > MAX_BULK) {
		throw new ApiError(400, `Select 1 to ${MAX_BULK} audits`);
	}
	const message = text(req.body?.message, "Message");

	let sent = 0;
	for (const id of ids) {
		const audit = await loadAuditOrThrow(scope, id);
		const withDealer =
			DEALER_EDITABLE.includes(audit.status) ||
			audit.status === AUDIT_STATUS.CLARIFICATION_REQUIRED;
		const withReviewer = (
			[
				AUDIT_STATUS.SUBMITTED,
				AUDIT_STATUS.RESUBMITTED,
				AUDIT_STATUS.UNDER_REVIEW,
			] as string[]
		).includes(audit.status);
		if (!withDealer && !withReviewer) continue;
		const notifyOwner = withDealer ? notifyDealer : notifyReviewer;
		await notifyOwner(
			audit.id,
			"Dealer Audit reminder",
			message || "Please complete your pending action on this audit.",
		);
		sent += 1;
	}
	ok(res, { sent_count: sent, sent_at: new Date().toISOString() });
}

export async function resendReport(req: Request, res: Response) {
	const scope = await managerScope(req);
	const audit = await loadAuditOrThrow(scope, param(req, "id"));
	if (!REPORT_STATUSES.includes(audit.status)) {
		throw new ApiError(409, "The report can be emailed after the audit closes");
	}
	const recipients: string[] = Array.isArray(req.body?.recipients)
		? [
				...new Set<string>(
					req.body.recipients.map((e: unknown) => String(e).trim()),
				),
			]
		: [];
	const valid = recipients.every((e) =>
		/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e),
	);
	if (!recipients.length || recipients.length > MAX_RECIPIENTS || !valid) {
		throw new ApiError(
			400,
			`Enter 1 to ${MAX_RECIPIENTS} valid email addresses`,
		);
	}
	const result = await sendReportMail(audit.id, recipients);
	ok(res, {
		sent_at: result.sentAt.toISOString(),
		recipient_count: result.recipientCount,
	});
}

// Admin only (enforced on the route).
export async function reassignReviewer(req: Request, res: Response) {
	const userId = getAuthenticatedUser(req).id;
	const scope: Scope = { kind: "ALL" };
	const audit = await loadAuditOrThrow(scope, param(req, "id"));
	const reviewerId = String(req.body?.reviewer_id ?? "");
	const reason = text(req.body?.reason, "Reason");
	if (!reason) throw new ApiError(400, "A reason is required");
	const eligible = await listReviewerOptions();
	if (!eligible.some((r) => r.id === reviewerId)) {
		throw new ApiError(400, "Choose a user who can review Dealer Audits");
	}
	const locked = [
		...FINISHED_AUDIT_STATUSES,
		AUDIT_STATUS.PENDING_APPROVAL,
	] as string[];
	if (locked.includes(audit.status)) {
		throw new ApiError(409, "The reviewer can no longer be changed");
	}
	await prisma.$transaction(async (tx) => {
		await move(tx, audit.id, [audit.status], {
			status: audit.status as AuditStatus,
			reviewerId,
			lastReminderAt: null,
		});
		await log(tx, userId, "DEALER_AUDIT_REVIEWER_REASSIGNED", audit.id, {
			from: audit.reviewerId,
			to: reviewerId,
			reason,
		});
	});
	await notifyReviewer(
		audit.id,
		"Audit assigned to you",
		"You are now the reviewer for this audit.",
	);
	ok(res, await buildAudit(scope, audit.id));
}

// Admin only (enforced on the route). Creates a fresh audit linked to a closed one.
export async function createReAudit(req: Request, res: Response) {
	const userId = getAuthenticatedUser(req).id;
	const scope: Scope = { kind: "ALL" };
	const audit = await loadAuditOrThrow(scope, param(req, "id"));
	if (!REPORT_STATUSES.includes(audit.status)) {
		throw new ApiError(409, "Only a completed audit can be audited again");
	}
	const reason = text(req.body?.reason, "Reason");
	if (!reason) throw new ApiError(400, "A reason is required");
	const day = String(req.body?.due_date ?? "");
	const dueAt = new Date(`${day}T23:59:59+05:30`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(dueAt.getTime() > Date.now())) {
		throw new ApiError(400, "Choose a due date that is not in the past");
	}

	const id = randomUUID();
	await prisma.$transaction(async (tx) => {
		const siblings = await tx.dealerAuditInstance.findMany({
			where: {
				businessPartnerId: audit.businessPartnerId,
				officeType: audit.officeType,
				periodLabel: audit.periodLabel,
			},
			select: { sequence: true, status: true },
		});
		const finished = FINISHED_AUDIT_STATUSES as readonly string[];
		if (siblings.some((s) => !finished.includes(s.status))) {
			throw new ApiError(409, "A re-audit is already open for this dealer");
		}
		await tx.dealerAuditInstance.create({
			data: {
				id,
				cycleId: audit.cycleId,
				businessPartnerId: audit.businessPartnerId,
				workspaceId: audit.workspaceId,
				officeType: audit.officeType,
				periodLabel: audit.periodLabel,
				checklistTemplateId: audit.checklistTemplateId,
				reviewerId: audit.reviewerId,
				auditType: "RE_AUDIT",
				sequence: Math.max(...siblings.map((s) => s.sequence)) + 1,
				parentId: audit.id,
				dueAt,
				status: AUDIT_STATUS.DRAFT,
			},
		});
		await tx.dealerAuditInstance.update({
			where: { id: audit.id },
			data: { reAuditRequestedAt: new Date(), reAuditReason: reason },
		});
		await log(tx, userId, "DEALER_AUDIT_CREATED", id, {
			parentId: audit.id,
			reason,
		});
	});
	await notifyDealer(
		id,
		"Re-audit assigned",
		"A new audit has been assigned to your dealership.",
	);
	ok(res, await buildAudit(scope, id));
}

// ─────────────────────────────────────────────
// Approver
// ─────────────────────────────────────────────
// The workflow module decides who may act. Final status is written by the
// DEALER_AUDIT_INSTANCE status updater in workflowSubject.helper.ts.

async function decide(req: Request, res: Response, approve: boolean) {
	const userId = getAuthenticatedUser(req).id;
	const auditId = param(req, "id");
	const reason = text(
		approve ? req.body?.remarks : req.body?.reason,
		"Remarks",
	);
	if (!approve && !reason) throw new ApiError(400, "A reason is required");

	const { stageId } = await getCurrentStageApprovalOrThrow(
		userId,
		SUBJECT_TYPE,
		auditId,
	);
	if (approve) {
		await approveStage({ stageId, userId, reason });
	} else {
		await rejectStage({ stageId, userId, reason });
		await log(prisma, userId, "REJECT", auditId, { reason });
	}
	ok(res, await buildAudit(await resolveScope(req), auditId, userId));
}

export const approveAudit = (req: Request, res: Response) =>
	decide(req, res, true);

export const rejectAudit = (req: Request, res: Response) =>
	decide(req, res, false);

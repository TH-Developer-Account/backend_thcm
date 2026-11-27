// Dealer Audit: read APIs for audits (list, detail, checklist, history, report).
// Written against prisma/schema.prisma (checklist score levels stored as Json).
// Response shapes follow the frontend's dealer-audit.types.ts (snake_case).
//
// Who sees what (enforced here, never trusted from the client):
//   ADMIN module write            every audit
//   REVIEW module write           only audits assigned to that reviewer
//   ADMIN module read (only)      every audit, read only
//   DEALER module read            only the user's own dealership

import type { Request, Response } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import logger from "@shared/utils/logger";
import { getSignedImageUrl } from "@shared/utils/aws-s3.services";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";
import { hasModulePermission } from "@rbac/profile/accessPolicy";
import { Prisma } from "../../prisma/generated/prisma/client";
import { getCurrentStageApprovalOrThrow } from "@kernel/workflow/workflowSubject.helper";
import { AUDIT_STATUS } from "./dealerAuditCycle.service";
import { createReportPdf, reportUrl } from "./dealerAuditReport.service";

const APP_KEY = "DEALER_AUDIT";
const SUBJECT_TYPE = "DEALER_AUDIT_INSTANCE";
const EVIDENCE_SUBJECT_TYPE = "DEALER_ITEM_RESPONSE";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// A final score exists and may be shown to the dealer.
export const REPORT_STATUSES: readonly string[] = [
	AUDIT_STATUS.APPROVED,
	AUDIT_STATUS.IMPROVEMENT_REQUIRED,
	AUDIT_STATUS.CLOSED,
];

// ─────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────

export type Scope =
	| { kind: "ALL" }
	| { kind: "ASSIGNED"; userId: string; approvalIds: string[] }
	| { kind: "DEALER"; businessPartnerId: string };

export async function resolveScope(req: Request): Promise<Scope> {
	const actor = getAuthenticatedUser(req);
	const can = (action: "read" | "write", moduleKey: string) =>
		hasModulePermission(actor, action, APP_KEY, moduleKey);

	// Dealer logins are checked first by their dealership link, so a wrongly
	// assigned staff profile can never widen what a dealer sees.
	const user = await prisma.user.findUnique({
		where: { id: actor.id },
		select: { businessPartnerId: true, userType: true },
	});
	if (user?.userType === "DEALER") {
		if (!user.businessPartnerId || !can("read", "DEALER_AUDIT_DEALER")) {
			throw new ApiError(403, "You do not have access to dealer audits");
		}
		return { kind: "DEALER", businessPartnerId: user.businessPartnerId };
	}

	if (can("write", "DEALER_AUDIT_ADMIN")) return { kind: "ALL" };
	const isReviewer = can("write", "DEALER_AUDIT_REVIEW");
	if (!isReviewer && can("read", "DEALER_AUDIT_ADMIN")) return { kind: "ALL" };

	// Approvers (reviewer's manager, final approver) also see the audits whose
	// approval chain they are part of.
	const workflows = await prisma.workflowInstance.findMany({
		where: {
			subjectType: SUBJECT_TYPE,
			stages: { some: { approvals: { some: { approverId: actor.id } } } },
		},
		select: { subjectId: true },
	});
	if (isReviewer || workflows.length) {
		return {
			kind: "ASSIGNED",
			userId: actor.id,
			approvalIds: workflows.map((w) => w.subjectId),
		};
	}
	throw new ApiError(403, "You do not have access to dealer audits");
}

function scopeWhere(scope: Scope): Prisma.DealerAuditInstanceWhereInput {
	if (scope.kind === "DEALER") {
		return { businessPartnerId: scope.businessPartnerId };
	}
	if (scope.kind === "ASSIGNED") {
		return {
			OR: [{ reviewerId: scope.userId }, { id: { in: scope.approvalIds } }],
		};
	}
	return {};
}

// ─────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────

const AUDIT_INCLUDE = {
	businessPartner: {
		select: {
			bpName: true,
			bpShortName: true,
			addresses: {
				orderBy: { isDefault: "desc" as const },
				take: 1,
				select: { city: true },
			},
		},
	},
	template: { include: { items: { orderBy: { order: "asc" as const } } } },
	cycle: {
		select: { periodType: true, periodYear: true, periodQuarter: true },
	},
	reviewer: { select: { id: true, first_name: true, last_name: true } },
	responses: true,
} satisfies Prisma.DealerAuditInstanceInclude;

type Audit = Prisma.DealerAuditInstanceGetPayload<{
	include: typeof AUDIT_INCLUDE;
}>;
type AuditResponse = Audit["responses"][number];
type Item = Audit["template"]["items"][number];

// Out-of-scope ids return 404, so nobody can probe which audits exist.
export async function loadAuditOrThrow(scope: Scope, id: string) {
	const audit = await prisma.dealerAuditInstance.findFirst({
		where: { AND: [{ id }, scopeWhere(scope)] },
		include: AUDIT_INCLUDE,
	});
	if (!audit) throw new ApiError(404, "Audit not found");
	return audit;
}

export function latestPerItem(responses: AuditResponse[]) {
	const latest = new Map<string, AuditResponse>();
	for (const response of responses) {
		const current = latest.get(response.itemId);
		if (!current || response.iteration > current.iteration) {
			latest.set(response.itemId, response);
		}
	}
	return latest;
}

const fullName = (user: { first_name: string; last_name: string }) =>
	[user.first_name, user.last_name].filter(Boolean).join(" ").trim();

function scoreLevelsOf(value: Prisma.JsonValue) {
	if (!Array.isArray(value)) return [];
	return (value as unknown as { score: number; criteria: string }[])
		.map(({ score, criteria }) => ({ score, criteria }))
		.sort((a, b) => a.score - b.score);
}

const sectionNameOf = (item: Item) => item.functionName || "General";

// ─────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────

function periodOf(audit: Audit) {
	const { cycle } = audit;
	if (cycle) {
		return {
			period_type: cycle.periodType,
			period_year: cycle.periodYear,
			period_quarter: cycle.periodQuarter,
		};
	}
	// Audits created before cycles existed only have a label such as "2026-Q3".
	const match = /(\d{4})(?:.*?Q([1-4]))?/i.exec(audit.periodLabel);
	const quarter = match?.[2] ? Number(match[2]) : null;
	return {
		period_type: quarter ? "QUARTERLY" : "YEARLY",
		period_year: match ? Number(match[1]) : audit.createdAt.getUTCFullYear(),
		period_quarter: quarter,
	};
}

export const isAnswered = (item: Item, response: AuditResponse | undefined) =>
	response?.isNotApplicable ||
	(item.requiresScore
		? response?.dealerScore != null
		: !!response?.dealerRemark?.trim());

function scoresOf(audit: Audit) {
	const latest = latestPerItem(audit.responses);
	let self: number | null = null;
	let completed = 0;
	let clarifications = 0;
	for (const item of audit.template.items) {
		const response = latest.get(item.id);
		if (isAnswered(item, response)) completed += 1;
		if (response?.dealerScore != null) {
			self = (self ?? 0) + response.dealerScore;
		}
		if (response?.reviewStatus === "CLARIFICATION_REQUESTED") {
			clarifications += 1;
		}
	}
	return { latest, self, completed, clarifications };
}

const auditNumber = (audit: Audit) =>
	`DA-${audit.periodLabel.replace(/\s+/g, "")}-${audit.id.slice(0, 6).toUpperCase()}`;

const maxScoreOf = (audit: Audit) =>
	audit.maxScore ?? audit.template.totalScore ?? 0;

export function toListItem(audit: Audit, scope: Scope) {
	const { self, completed, clarifications } = scoresOf(audit);
	const isDealer = scope.kind === "DEALER";
	const finalScore =
		isDealer && !REPORT_STATUSES.includes(audit.status)
			? null
			: audit.finalScore;

	return {
		id: audit.id,
		audit_number: auditNumber(audit),
		dealer_id: audit.businessPartnerId,
		dealer_code: audit.businessPartner.bpShortName,
		dealer_name: audit.businessPartner.bpName,
		location: audit.businessPartner.addresses[0]?.city ?? null,
		facility_type: audit.officeType,
		template_name: audit.template.name,
		template_version: audit.template.version,
		...periodOf(audit),
		status: audit.status,
		// Dealers never see who is reviewing them.
		assigned_reviewer:
			!isDealer && audit.reviewer
				? { id: audit.reviewer.id, name: fullName(audit.reviewer) }
				: null,
		due_at: audit.dueAt?.toISOString() ?? null,
		completed_items: completed,
		total_items: audit.template.items.length,
		self_score: self,
		final_score: finalScore,
		max_score: maxScoreOf(audit),
		final_score_source:
			finalScore == null
				? "PENDING"
				: audit.escalatedAt
					? "SELF_AUTO"
					: "REVIEWER",
		open_clarification_count:
			isDealer && audit.status !== AUDIT_STATUS.CLARIFICATION_REQUIRED
				? 0
				: clarifications,
		updated_at: audit.updatedAt.toISOString(),
	};
}

// ─────────────────────────────────────────────
// List
// ─────────────────────────────────────────────

const queryText = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

const positiveInt = (value: unknown, fallback: number) => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

function periodFilter(
	query: Request["query"],
): Prisma.DealerAuditInstanceWhereInput {
	const type = queryText(query.period_type);
	const year = positiveInt(query.period_year, 0);
	const quarter = positiveInt(query.period_quarter, 0);
	if (!type && !year && !quarter) return {};
	if (type && type !== "QUARTERLY" && type !== "YEARLY") {
		throw new ApiError(400, "period_type must be QUARTERLY or YEARLY");
	}

	return {
		cycle: {
			is: {
				...(type ? { periodType: type } : {}),
				...(year ? { periodYear: year } : {}),
				...(quarter ? { periodQuarter: quarter } : {}),
			},
		},
	};
}

export async function listAudits(req: Request, res: Response) {
	const scope = await resolveScope(req);
	const page = positiveInt(req.query.page, 1);
	const pageSize = Math.min(
		positiveInt(req.query.page_size, DEFAULT_PAGE_SIZE),
		MAX_PAGE_SIZE,
	);
	const search = queryText(req.query.search);
	const statuses = queryText(req.query.status).split(",").filter(Boolean);

	const filters: Prisma.DealerAuditInstanceWhereInput[] = [
		scopeWhere(scope),
		periodFilter(req.query),
	];
	if (statuses.length) filters.push({ status: { in: statuses } });
	if (search) {
		const contains = { contains: search, mode: "insensitive" as const };
		filters.push({
			OR: [
				{ businessPartner: { bpName: contains } },
				{ businessPartner: { bpShortName: contains } },
				{ template: { name: contains } },
				{ periodLabel: contains },
			],
		});
	}
	const where: Prisma.DealerAuditInstanceWhereInput = { AND: filters };

	const direction: Prisma.SortOrder =
		req.query.sort_order === "asc" ? "asc" : "desc";
	const sortBy = queryText(req.query.sort_by);
	const primary: Prisma.DealerAuditInstanceOrderByWithRelationInput =
		sortBy === "dueAt"
			? { dueAt: direction }
			: sortBy === "dealerName"
				? { businessPartner: { bpName: direction } }
				: sortBy === "status"
					? { status: direction }
					: { updatedAt: direction };

	const [total, audits] = await Promise.all([
		prisma.dealerAuditInstance.count({ where }),
		prisma.dealerAuditInstance.findMany({
			where,
			include: AUDIT_INCLUDE,
			// The id tiebreaker keeps pages from shuffling.
			orderBy: [primary, { id: "asc" }],
			skip: (page - 1) * pageSize,
			take: pageSize,
		}),
	]);
	res.status(200).json({
		success: true,
		data: audits.map((audit) => toListItem(audit, scope)),
		meta: {
			page,
			page_size: pageSize,
			total_items: total,
			total_pages: Math.max(1, Math.ceil(total / pageSize)),
		},
	});
}

// ─────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────

const activityFor = (auditId: string) =>
	prisma.activityLog.findMany({
		where: { subjectType: SUBJECT_TYPE, subjectId: auditId },
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			action: true,
			createdAt: true,
			actor: { select: { first_name: true, last_name: true } },
		},
	});

// The review is submitted (scores locked in) but not yet sent for approval.
export const isReviewSubmitted = (audit: {
	status: string;
	finalScore: number | null;
}) => audit.status === AUDIT_STATUS.UNDER_REVIEW && audit.finalScore !== null;

// Time of the report generated after the latest review submit, if any.
export async function currentReportTime(auditId: string) {
	const activity = await activityFor(auditId);
	const last = (action: string) =>
		activity.filter((a) => String(a.action) === action).pop()?.createdAt;
	const generated = last("DEALER_AUDIT_REPORT_GENERATED");
	const submitted = last("DEALER_AUDIT_REVIEW_SUBMITTED");
	return generated && submitted && generated >= submitted ? generated : null;
}

async function canApprove(userId: string, auditId: string) {
	try {
		await getCurrentStageApprovalOrThrow(userId, SUBJECT_TYPE, auditId);
		return true;
	} catch (error) {
		// 4xx means "not a pending approver"; anything else is a real failure.
		if (error instanceof ApiError) return false;
		throw error;
	}
}

export async function buildAudit(scope: Scope, id: string, viewerId?: string) {
	const audit = await loadAuditOrThrow(scope, id);
	// Older audits have no submittedAt column value; fall back to the log.
	const submittedAt =
		audit.submittedAt ??
		(await activityFor(audit.id)).find(
			(a) => a.action === "DEALER_AUDIT_SUBMITTED",
		)?.createdAt;

	const internal = scope.kind !== "DEALER";
	const submitted = internal && isReviewSubmitted(audit);
	const pending = audit.status === AUDIT_STATUS.PENDING_APPROVAL;
	const reportAt =
		submitted || (internal && pending)
			? await currentReportTime(audit.id)
			: null;

	return {
		...toListItem(audit, scope),
		review_submitted: submitted,
		report_generated_at: reportAt?.toISOString() ?? null,
		viewer_can_approve:
			internal && pending && !!viewerId
				? await canApprove(viewerId, audit.id)
				: false,
		template_id: audit.checklistTemplateId,
		created_at: audit.createdAt.toISOString(),
		submitted_at: submittedAt?.toISOString() ?? null,
		closed_at: audit.closedAt?.toISOString() ?? null,
		// No version column yet; added with the write APIs.
		version: 1,
		auto_finalize_at: null,
	};
}

export async function getAudit(req: Request, res: Response) {
	const scope = await resolveScope(req);
	res.status(200).json({
		success: true,
		data: await buildAudit(
			scope,
			req.params.id as string,
			getAuthenticatedUser(req).id,
		),
	});
}

// ─────────────────────────────────────────────
// Checklist
// ─────────────────────────────────────────────

async function evidenceByItem(audit: Audit) {
	const itemByResponse = new Map(audit.responses.map((r) => [r.id, r.itemId]));
	const responseIds = [...itemByResponse.keys()];
	// Existing uploads link by subjectId; the schema also has a direct relation.
	const rows = await prisma.evidence.findMany({
		where: {
			OR: [
				{ auditItemResponseId: { in: responseIds } },
				{
					subjectType: EVIDENCE_SUBJECT_TYPE,
					subjectId: { in: responseIds },
				},
			],
		},
		orderBy: { capturedAt: "asc" },
	});

	const grouped = new Map<string, unknown[]>();
	await Promise.all(
		rows.map(async (row) => {
			const itemId = itemByResponse.get(
				row.auditItemResponseId ?? row.subjectId ?? "",
			);
			if (!itemId) return;
			const url = await getSignedImageUrl(row.s3Key);
			const list = grouped.get(itemId) ?? [];
			grouped.set(itemId, list);
			list.push({
				id: row.id,
				url,
				thumbnail_url: null,
				// Keys end in "<uuid>-<original name>".
				file_name: (row.s3Key.split("/").pop() ?? "photo").slice(37) || "photo",
				size_bytes: null,
				mime_type: null,
				captured_at: row.capturedAt.toISOString(),
				latitude: row.geoLat ?? 0,
				longitude: row.geoLng ?? 0,
				accuracy_m: row.accuracyMeters,
			});
		}),
	);
	return grouped;
}

// TEMPORARY: set to true to make photos mandatory again.
const PHOTOS_MANDATORY = false;

export const requiredPhotos = (item: {
	requiresEvidence: boolean;
	minEvidence: number | null;
}) => (PHOTOS_MANDATORY && item.requiresEvidence ? (item.minEvidence ?? 1) : 0);

export async function buildChecklist(scope: Scope, id: string) {
	const audit = await loadAuditOrThrow(scope, id);
	const latest = latestPerItem(audit.responses);
	const evidence = await evidenceByItem(audit);
	const isDealer = scope.kind === "DEALER";

	const sections = new Map<
		string,
		{ id: string; sequence: number; name: string; items: unknown[] }
	>();

	audit.template.items.forEach((item, index) => {
		const name = sectionNameOf(item);
		let section = sections.get(name);
		if (!section) {
			const sequence = sections.size + 1;
			section = { id: `section-${sequence}`, sequence, name, items: [] };
			sections.set(name, section);
		}

		const response = latest.get(item.id);
		const photos = evidence.get(item.id) ?? [];
		const needed = item.requiresEvidence ? (item.minEvidence ?? 1) : 0;
		// A dealer sees a flag only once the clarification has been raised.
		const flagged =
			response?.reviewStatus === "CLARIFICATION_REQUESTED" &&
			(!isDealer || audit.status === AUDIT_STATUS.CLARIFICATION_REQUIRED);
		const reviewed =
			response?.reviewerScore != null || !!response?.reviewerRemark;

		section.items.push({
			id: item.id,
			sequence: index + 1,
			section_id: section.id,
			section_name: section.name,
			title: item.label,
			guidance: item.checkPoint,
			criteria: [],
			category: item.categoryName,
			function_area: item.functionName,
			is_scored: item.requiresScore,
			score_levels: scoreLevelsOf(item.scoreLevels),
			min_score: null,
			max_score: item.maxScore,
			evidence_required: item.requiresEvidence,
			min_evidence_count: item.minEvidence,
			max_evidence_count: item.maxEvidence,
			self: response
				? {
						score: response.dealerScore,
						remarks: response.dealerRemark,
						evidence: photos,
						answered_at: (
							response.dealerRespondedAt ?? response.updatedAt
						).toISOString(),
						is_complete: isAnswered(item, response) && photos.length >= needed,
					}
				: null,
			// The reviewer's assessment is never sent to a dealer. A dealer only
			// gets the remark on an item they are asked to clarify.
			review:
				!isDealer && response && reviewed
					? {
							score: response.reviewerScore,
							remarks: response.reviewerRemark,
							decision: response.isNotApplicable
								? "NOT_APPLICABLE"
								: response.reviewStatus === "APPROVED"
									? "ACCEPTED"
									: flagged
										? "CLARIFICATION_REQUIRED"
										: "PENDING",
							score_change_reason: null,
							reviewed_at: response.reviewedAt?.toISOString() ?? null,
						}
					: null,
			clarification:
				response && flagged
					? {
							id: response.id,
							status: "OPEN",
							remarks: response.reviewerRemark ?? "",
							raised_at: (
								response.reviewedAt ?? response.updatedAt
							).toISOString(),
							due_at: audit.clarificationDueAt?.toISOString() ?? null,
							response: null,
							responded_at: null,
						}
					: null,
		});
	});

	return {
		audit_id: audit.id,
		dealer_name: audit.businessPartner.bpName,
		dealer_code: audit.businessPartner.bpShortName,
		location: audit.businessPartner.addresses[0]?.city ?? null,
		status: audit.status,
		version: 1,
		sections: [...sections.values()],
	};
}

export async function getChecklist(req: Request, res: Response) {
	const scope = await resolveScope(req);
	res.status(200).json({
		success: true,
		data: await buildChecklist(scope, req.params.id as string),
	});
}

// ─────────────────────────────────────────────
// History (internal users only)
// ─────────────────────────────────────────────

const HISTORY_ACTIONS: Record<string, string> = {
	DEALER_AUDIT_CREATED: "CREATED",
	DEALER_AUDIT_REVIEW_STARTED: "REVIEW_STARTED",
	DEALER_AUDIT_CLARIFICATION_RAISED: "CLARIFICATION_RAISED",
	DEALER_AUDIT_CLARIFICATION_RESPONDED: "CLARIFICATION_RESPONDED",
	DEALER_AUDIT_REVIEW_SUBMITTED: "REVIEW_SUBMITTED",
	DEALER_AUDIT_AUTO_FINALIZED: "AUTO_FINALIZED",
	DEALER_AUDIT_EXPIRED: "EXPIRED",
	APPROVED: "APPROVED",
	DEALER_AUDIT_SUBMITTED: "SUBMITTED",
	DEALER_AUDIT_RESUBMITTED: "RESUBMITTED",
	DEALER_AUDIT_REVIEWER_NOTES_SET: "ITEM_REVIEWED",
	DEALER_AUDIT_REVIEW_STATUS_SET: "ITEM_REVIEWED",
	APPROVE: "APPROVED",
	REJECT: "REJECTED",
	CLARIFY: "CLARIFICATION_RAISED",
};

export async function getHistory(req: Request, res: Response) {
	const scope = await resolveScope(req);
	if (scope.kind === "DEALER") {
		throw new ApiError(403, "Audit history is not available to dealers");
	}
	const audit = await loadAuditOrThrow(scope, req.params.id as string);
	const activity = await activityFor(audit.id);

	res.status(200).json({
		success: true,
		data: activity.flatMap((entry) => {
			const action = HISTORY_ACTIONS[String(entry.action)];
			if (!action) return [];
			return [
				{
					id: entry.id,
					action,
					actor_name: entry.actor ? fullName(entry.actor) : "System",
					actor_role: null,
					occurred_at: entry.createdAt.toISOString(),
					from_status: null,
					to_status: null,
					comment: null,
				},
			];
		}),
	});
}

// ─────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────

export async function getReport(req: Request, res: Response) {
	const scope = await resolveScope(req);
	const audit = await loadAuditOrThrow(scope, req.params.id as string);
	// Reviewer and approver preview the report before approval; dealers cannot.
	const preview =
		scope.kind !== "DEALER" &&
		(isReviewSubmitted(audit) ||
			audit.status === AUDIT_STATUS.PENDING_APPROVAL);
	if (!REPORT_STATUSES.includes(audit.status) && !preview) {
		throw new ApiError(
			409,
			"The report is available once the audit has a final score",
		);
	}
	const summary = toListItem(audit, scope);
	const latest = latestPerItem(audit.responses);

	const sections = new Map<
		string,
		{ section_id: string; name: string; score: number; max_score: number }
	>();
	for (const item of audit.template.items) {
		const name = sectionNameOf(item);
		const section = sections.get(name) ?? {
			section_id: `section-${sections.size + 1}`,
			name,
			score: 0,
			max_score: 0,
		};
		// Same rule that produced the final score: nothing submitted = 0,
		// auto-finalised = dealer score, otherwise the reviewer's score.
		const response = latest.get(item.id);
		section.score += !audit.submittedAt
			? 0
			: audit.escalatedAt
				? (response?.dealerScore ?? 0)
				: response?.isNotApplicable
					? 0
					: (response?.reviewerScore ?? response?.dealerScore ?? 0);
		section.max_score += item.requiresScore ? (item.maxScore ?? 0) : 0;
		sections.set(name, section);
	}

	// A PDF failure must not hide the on-screen scorecard.
	let downloadUrl: string | null = null;
	try {
		downloadUrl = await reportUrl((await createReportPdf(audit.id)).key);
	} catch (error) {
		logger.error(
			`[DealerAudit] Report PDF failed for ${audit.id}: ${(error as Error).message}`,
		);
	}

	res.status(200).json({
		success: true,
		data: {
			audit_id: audit.id,
			audit_number: summary.audit_number,
			dealer_name: summary.dealer_name,
			dealer_code: summary.dealer_code,
			location: summary.location,
			period_type: summary.period_type,
			period_year: summary.period_year,
			period_quarter: summary.period_quarter,
			status: summary.status,
			self_score: summary.self_score,
			final_score: summary.final_score,
			max_score: summary.max_score,
			final_score_source: summary.final_score_source,
			sections: [...sections.values()],
			generated_at: new Date().toISOString(),
			download_url: downloadUrl,
		},
	});
}

// ─────────────────────────────────────────────
// Dashboard / tracker counts (same scope rules as the list)
// ─────────────────────────────────────────────

const CLOSED_STATUSES = [...REPORT_STATUSES];
const NOT_SUBMITTED: string[] = [AUDIT_STATUS.DRAFT, AUDIT_STATUS.IN_PROGRESS];

async function scopedRows(req: Request) {
	const scope = await resolveScope(req);
	return prisma.dealerAuditInstance.findMany({
		where: { AND: [scopeWhere(scope), periodFilter(req.query)] },
		select: { status: true, dueAt: true, finalScore: true, maxScore: true },
	});
}

type CountRow = Awaited<ReturnType<typeof scopedRows>>[number];

const countIn = (rows: CountRow[], ...statuses: string[]) =>
	rows.filter((row) => statuses.includes(row.status)).length;

export async function getTrackerSummary(req: Request, res: Response) {
	const rows = await scopedRows(req);
	const now = Date.now();
	const percents = rows.flatMap((row) =>
		CLOSED_STATUSES.includes(row.status) &&
		row.finalScore !== null &&
		row.maxScore
			? [(row.finalScore / row.maxScore) * 100]
			: [],
	);

	res.status(200).json({
		success: true,
		data: {
			total: rows.length,
			not_started: countIn(rows, AUDIT_STATUS.DRAFT),
			in_progress: countIn(rows, AUDIT_STATUS.IN_PROGRESS),
			awaiting_review: countIn(
				rows,
				AUDIT_STATUS.SUBMITTED,
				AUDIT_STATUS.RESUBMITTED,
				AUDIT_STATUS.UNDER_REVIEW,
			),
			clarification: countIn(
				rows,
				AUDIT_STATUS.CLARIFICATION_REQUIRED,
				AUDIT_STATUS.RECTIFICATION_IN_PROGRESS,
			),
			awaiting_approval: countIn(rows, AUDIT_STATUS.PENDING_APPROVAL),
			closed: countIn(rows, ...CLOSED_STATUSES),
			overdue: rows.filter(
				(row) =>
					NOT_SUBMITTED.includes(row.status) &&
					!!row.dueAt &&
					row.dueAt.getTime() < now,
			).length,
			average_score_percent: percents.length
				? Math.round(
						(percents.reduce((a, b) => a + b, 0) / percents.length) * 10,
					) / 10
				: null,
		},
	});
}

export async function getReviewQueueCounts(req: Request, res: Response) {
	const rows = await scopedRows(req);
	res.status(200).json({
		success: true,
		data: {
			to_review: countIn(
				rows,
				AUDIT_STATUS.SUBMITTED,
				AUDIT_STATUS.RESUBMITTED,
			),
			in_review: countIn(rows, AUDIT_STATUS.UNDER_REVIEW),
			with_dealer: countIn(
				rows,
				AUDIT_STATUS.CLARIFICATION_REQUIRED,
				AUDIT_STATUS.RECTIFICATION_IN_PROGRESS,
			),
			completed: countIn(
				rows,
				AUDIT_STATUS.PENDING_APPROVAL,
				AUDIT_STATUS.REJECTED,
				...CLOSED_STATUSES,
			),
		},
	});
}

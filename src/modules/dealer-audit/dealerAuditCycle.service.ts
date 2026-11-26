import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { getSignedImageUrl } from "@shared/utils/aws-s3.services";

import {
	BusinessPartnerOfficeType,
	Prisma,
} from "../../prisma/generated/prisma/client";

// Dealer Audit instance statuses. The DB column is a plain String (no Prisma
// enum), so adding a status never needs a migration: add it here only.
// Values match the frontend's AuditInstanceStatus.
export const AUDIT_STATUS = {
	DRAFT: "DRAFT",
	IN_PROGRESS: "IN_PROGRESS",
	SUBMITTED: "SUBMITTED",
	UNDER_REVIEW: "UNDER_REVIEW",
	CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
	RECTIFICATION_IN_PROGRESS: "RECTIFICATION_IN_PROGRESS",
	RESUBMITTED: "RESUBMITTED",
	PENDING_APPROVAL: "PENDING_APPROVAL",
	APPROVED: "APPROVED",
	IMPROVEMENT_REQUIRED: "IMPROVEMENT_REQUIRED",
	CLOSED: "CLOSED",
	REJECTED: "REJECTED",
	EXPIRED: "EXPIRED",
	CANCELLED: "CANCELLED",
} as const;

export type AuditStatus = (typeof AUDIT_STATUS)[keyof typeof AUDIT_STATUS];

// Statuses where an audit no longer counts as open work for a reviewer.
export const FINISHED_AUDIT_STATUSES: readonly AuditStatus[] = [
	AUDIT_STATUS.APPROVED,
	AUDIT_STATUS.IMPROVEMENT_REQUIRED,
	AUDIT_STATUS.CLOSED,
	AUDIT_STATUS.REJECTED,
	AUDIT_STATUS.EXPIRED,
	AUDIT_STATUS.CANCELLED,
];

// ─────────────────────────────────────────────
// Cycle launch + the two option lists the "Create audit cycle" wizard needs.
//
//   POST /dealer-audit/cycles              launchDealerAuditCycle
//   GET  /dealer-audit/options/reviewers   listReviewerOptions
//   GET  /dealer-audit/options/dealers     listDealerOptions
//
// One launch creates one DealerAuditCycle row plus one DealerAuditInstance per
// selected dealer, all in a single transaction: either every audit is created
// or none is. Everything is validated first so the admin gets one list of
// problems instead of a failure on the first bad dealer.
// ─────────────────────────────────────────────

const APP_KEY = "DEALER_AUDIT";
const REVIEW_MODULE_KEY = "DEALER_AUDIT_REVIEW";
const DEALER_BP_TYPE = "DEALER";
const DEALER_USER_TYPE = "DEALER";

const MAX_ASSIGNMENTS = 1000;
const MAX_PROBLEMS_SHOWN = 8;

export type LaunchCycleInput = {
	name: string;
	template_id: string;
	period_type: "QUARTERLY" | "YEARLY";
	period_year: number;
	period_quarter: number | null;
	period_label: string;
	due_date: string;
	assignments: { dealer_id: string; reviewer_id: string }[];
};

// A reviewer is any active user who holds write access on the Dealer Audit
// review module through their profile for that app. Single definition, used by
// both the option list and the launch validation, so the two can never drift.
const reviewerWhere: Prisma.UserWhereInput = {
	is_active: true,
	userProfiles: {
		some: {
			profile: {
				app: { key: APP_KEY },
				permissions: {
					some: {
						action: "write" as never,
						module: { key: REVIEW_MODULE_KEY },
					},
				},
			},
		},
	},
};

// Date-only strings ("2026-12-31") mean the END of that day in India time, so
// a dealer is never told it is overdue on the due date itself.
function parseDueDate(value: unknown): Date {
	if (typeof value !== "string" || !value.trim()) {
		throw new ApiError(400, "due_date is required");
	}
	const text = value.trim();
	const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
		? new Date(`${text}T23:59:59+05:30`)
		: new Date(text);
	if (Number.isNaN(date.getTime())) {
		throw new ApiError(400, "due_date is not a valid date");
	}
	if (date.getTime() < Date.now()) {
		throw new ApiError(400, "due_date cannot be in the past");
	}
	return date;
}

function fullName(user: {
	first_name: string | null;
	last_name: string | null;
}) {
	return [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
}

function validateShape(input: LaunchCycleInput) {
	const name = input.name?.trim();
	if (!name) throw new ApiError(400, "name is required");
	if (name.length > 120) {
		throw new ApiError(400, "name must be 120 characters or fewer");
	}
	if (!input.template_id) throw new ApiError(400, "template_id is required");

	if (input.period_type !== "QUARTERLY" && input.period_type !== "YEARLY") {
		throw new ApiError(400, "period_type must be QUARTERLY or YEARLY");
	}
	if (!Number.isInteger(input.period_year)) {
		throw new ApiError(400, "period_year must be a whole number");
	}
	const quarter = input.period_quarter;
	if (input.period_type === "QUARTERLY") {
		if (!Number.isInteger(quarter) || quarter! < 1 || quarter! > 4) {
			throw new ApiError(
				400,
				"period_quarter must be 1 to 4 for a quarterly cycle",
			);
		}
	} else if (quarter !== null && quarter !== undefined) {
		throw new ApiError(400, "period_quarter must be empty for a yearly cycle");
	}
	const periodLabel = input.period_label?.trim();
	if (!periodLabel) throw new ApiError(400, "period_label is required");

	if (!Array.isArray(input.assignments) || input.assignments.length === 0) {
		throw new ApiError(400, "Select at least one dealer");
	}
	if (input.assignments.length > MAX_ASSIGNMENTS) {
		throw new ApiError(
			400,
			`A cycle can include at most ${MAX_ASSIGNMENTS} dealers`,
		);
	}
	const seen = new Set<string>();
	for (const a of input.assignments) {
		if (!a?.dealer_id || !a?.reviewer_id) {
			throw new ApiError(400, "Every dealer needs a reviewer");
		}
		if (seen.has(a.dealer_id)) {
			throw new ApiError(400, "The same dealer is listed twice");
		}
		seen.add(a.dealer_id);
	}

	return { name, periodLabel };
}

export async function launchDealerAuditCycle(
	actorId: string,
	input: LaunchCycleInput,
) {
	const { name, periodLabel } = validateShape(input);
	const dueAt = parseDueDate(input.due_date);

	const template = await prisma.checklistTemplate.findUnique({
		where: { id: input.template_id },
		select: {
			id: true,
			name: true,
			officeType: true,
			status: true,
			isActive: true,
		},
	});
	if (!template) throw new ApiError(404, "Checklist template not found");
	if (template.status !== "PUBLISHED" || !template.isActive) {
		throw new ApiError(
			400,
			"Only a published, active checklist can be used for a cycle",
		);
	}

	const dealerIds = input.assignments.map((a) => a.dealer_id);
	const reviewerIds = [...new Set(input.assignments.map((a) => a.reviewer_id))];

	const [dealers, reviewers, existing, contacts] = await Promise.all([
		prisma.businessPartner.findMany({
			where: { id: { in: dealerIds } },
			select: {
				id: true,
				bpName: true,
				officeType: true,
				bpType: true,
				isActive: true,
			},
		}),
		prisma.user.findMany({
			where: { id: { in: reviewerIds }, ...reviewerWhere },
			select: { id: true },
		}),
		prisma.dealerAuditInstance.findMany({
			where: { businessPartnerId: { in: dealerIds }, periodLabel },
			select: { businessPartnerId: true },
		}),
		// The dealership's primary contact decides which workspace the audit lives
		// in (same rule as triggerDealerAuditInstance).
		prisma.user.findMany({
			where: {
				businessPartnerId: { in: dealerIds },
				isDefaultContact: true,
				is_active: true,
			},
			select: {
				id: true,
				businessPartnerId: true,
				workspaceUsers: { select: { workspaceId: true } },
			},
		}),
	]);

	const dealerById = new Map(dealers.map((d) => [d.id, d]));
	const validReviewers = new Set(reviewers.map((r) => r.id));
	const alreadyAudited = new Set(existing.map((e) => e.businessPartnerId));
	const contactByDealer = new Map(
		contacts.map((c) => [c.businessPartnerId as string, c]),
	);

	const problems: string[] = [];
	const workspaceByDealer = new Map<string, string>();

	for (const assignment of input.assignments) {
		const dealer = dealerById.get(assignment.dealer_id);
		if (!dealer) {
			problems.push(`Dealer ${assignment.dealer_id} was not found`);
			continue;
		}
		const label = dealer.bpName;
		if (!dealer.isActive) problems.push(`${label} is inactive`);
		if (dealer.bpType !== DEALER_BP_TYPE)
			problems.push(`${label} is not a dealer`);
		if (dealer.officeType !== template.officeType) {
			problems.push(`${label} is a different office type from this checklist`);
		}
		if (alreadyAudited.has(dealer.id)) {
			problems.push(`${label} already has an audit for ${periodLabel}`);
		}
		if (!validReviewers.has(assignment.reviewer_id)) {
			problems.push(`${label} has a reviewer who cannot review Dealer Audits`);
		}

		const contact = contactByDealer.get(dealer.id);
		if (!contact) {
			problems.push(`${label} has no active primary contact user`);
		} else if (contact.workspaceUsers.length !== 1) {
			problems.push(
				`${label}'s primary contact must belong to exactly one workspace (found ${contact.workspaceUsers.length})`,
			);
		} else {
			workspaceByDealer.set(dealer.id, contact.workspaceUsers[0].workspaceId);
		}
	}

	if (problems.length > 0) {
		const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).join("; ");
		const more =
			problems.length > MAX_PROBLEMS_SHOWN
				? ` (and ${problems.length - MAX_PROBLEMS_SHOWN} more)`
				: "";
		throw new ApiError(
			422,
			`Cannot launch the cycle: ${shown}${more}. Nothing was created.`,
		);
	}

	const cycleId = randomUUID();
	const auditIds = input.assignments.map(() => randomUUID());

	await prisma.$transaction(async (tx) => {
		await tx.dealerAuditCycle.create({
			data: {
				id: cycleId,
				name,
				checklistTemplateId: template.id,
				periodType: input.period_type,
				periodYear: input.period_year,
				periodQuarter: input.period_quarter ?? null,
				periodLabel,
				dueAt,
				createdById: actorId,
			},
		});

		await tx.dealerAuditInstance.createMany({
			data: input.assignments.map((assignment, index) => ({
				id: auditIds[index],
				cycleId,
				businessPartnerId: assignment.dealer_id,
				workspaceId: workspaceByDealer.get(assignment.dealer_id) as string,
				officeType: template.officeType,
				periodLabel,
				checklistTemplateId: template.id,
				reviewerId: assignment.reviewer_id,
				dueAt,
				status: AUDIT_STATUS.DRAFT,
			})),
		});

		await tx.activityLog.createMany({
			data: auditIds.map((auditId, index) => ({
				actorId,
				action: "DEALER_AUDIT_CREATED",
				subjectType: "DEALER_AUDIT_INSTANCE" as never,
				subjectId: auditId,
				metadata: {
					cycleId,
					reviewerId: input.assignments[index].reviewer_id,
				},
			})),
		});
	});

	return {
		created_count: auditIds.length,
		audit_ids: auditIds,
		cycle_id: cycleId,
	};
}

// ─────────────────────────────────────────────
// Option lists
// ─────────────────────────────────────────────

export async function listReviewerOptions() {
	const users = await prisma.user.findMany({
		where: reviewerWhere,
		select: {
			id: true,
			first_name: true,
			last_name: true,
			designation: { select: { name: true } },
			zones: { select: { region_name: true } },
		},
		orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
	});

	// Plain findMany + tally instead of groupBy: groupBy's generic types are
	// fragile and the open-audit counts are small.
	const open = await prisma.dealerAuditInstance.findMany({
		where: {
			reviewerId: { in: users.map((u) => u.id) },
			status: { notIn: [...FINISHED_AUDIT_STATUSES] },
		},
		select: { reviewerId: true },
	});
	const openByReviewer = new Map<string, number>();
	for (const row of open) {
		if (!row.reviewerId) continue;
		openByReviewer.set(
			row.reviewerId,
			(openByReviewer.get(row.reviewerId) ?? 0) + 1,
		);
	}

	return users.map((user) => ({
		id: user.id,
		name: fullName(user) || user.id,
		designation: user.designation?.name ?? null,
		zones: user.zones.map((zone) => zone.region_name),
		open_audits: openByReviewer.get(user.id) ?? 0,
	}));
}

export async function listDealerOptions() {
	const dealers = await prisma.businessPartner.findMany({
		where: { isActive: true, bpType: DEALER_BP_TYPE },
		select: {
			id: true,
			bpName: true,
			bpShortName: true,
			officeType: true,
			addresses: {
				orderBy: { isDefault: "desc" },
				take: 1,
				select: { city: true, state: true, zone: true },
			},
		},
		orderBy: { bpName: "asc" },
	});

	// Latest closed audit per dealer, for the "Last audit" column.
	const closed = await prisma.dealerAuditInstance.findMany({
		where: {
			businessPartnerId: { in: dealers.map((d) => d.id) },
			closedAt: { not: null },
		},
		orderBy: { closedAt: "desc" },
		select: {
			businessPartnerId: true,
			periodLabel: true,
			closedAt: true,
			finalScore: true,
			maxScore: true,
		},
	});
	const lastByDealer = new Map<string, (typeof closed)[number]>();
	for (const audit of closed) {
		if (!lastByDealer.has(audit.businessPartnerId)) {
			lastByDealer.set(audit.businessPartnerId, audit);
		}
	}

	return dealers.map((dealer) => {
		const address = dealer.addresses[0];
		const last = lastByDealer.get(dealer.id);
		return {
			id: dealer.id,
			code: dealer.bpShortName,
			name: dealer.bpName,
			location: address?.city ?? null,
			facility_type: dealer.officeType as BusinessPartnerOfficeType,
			zone: address?.zone ?? null,
			state: address?.state ?? null,
			last_audit: last
				? {
						period_label: last.periodLabel,
						closed_at: last.closedAt?.toISOString() ?? null,
						final_score: last.finalScore,
						max_score: last.maxScore,
					}
				: null,
		};
	});
}

// ─────────────────────────────────────────────
// Audit list + tracker summary
//
//   GET /dealer-audit/audits            listAudits / listMyAudits (dealers)
//   GET /dealer-audit/mine              listMyAudits
//   GET /dealer-audit/tracker/summary   getTrackerSummary
// ─────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SORT_FIELDS = ["dueAt", "updatedAt", "dealerName", "status"] as const;
type SortField = (typeof SORT_FIELDS)[number];

type RawQuery = Record<string, unknown>;

const queryText = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

function queryInt(value: unknown, name: string): number | undefined {
	const text = queryText(value);
	if (!text) return undefined;
	const parsed = Number(text);
	if (!Number.isInteger(parsed)) {
		throw new ApiError(400, `${name} must be a whole number`);
	}
	return parsed;
}

// Period filters live on the cycle, so resolve matching cycle ids first.
async function periodWhere(
	query: RawQuery,
): Promise<Prisma.DealerAuditInstanceWhereInput> {
	const periodType = queryText(query.period_type);
	const year = queryInt(query.period_year, "period_year");
	const quarter = queryInt(query.period_quarter, "period_quarter");
	if (periodType && periodType !== "QUARTERLY" && periodType !== "YEARLY") {
		throw new ApiError(400, "period_type must be QUARTERLY or YEARLY");
	}
	if (!periodType && year === undefined && quarter === undefined) return {};

	const cycles = await prisma.dealerAuditCycle.findMany({
		where: {
			periodType: periodType ? (periodType as never) : undefined,
			periodYear: year,
			periodQuarter: quarter,
		},
		select: { id: true },
	});
	return { cycleId: { in: cycles.map((c) => c.id) } };
}

// There is no audit number column, so it is derived from the id (stable and
// searchable).
const auditNumber = (id: string, year: number) =>
	`DA-${year}-${id.slice(0, 8).toUpperCase()}`;

// Audits created before cycles existed only have a label such as "2026-Q3".
function resolvePeriod(
	cycle:
		| {
				periodType: unknown;
				periodYear: number;
				periodQuarter: number | null;
		  }
		| undefined,
	label: string,
	createdAt: Date,
) {
	if (cycle) {
		return {
			type: String(cycle.periodType),
			year: cycle.periodYear,
			quarter: cycle.periodQuarter,
		};
	}
	const match = /^(\d{4})-Q([1-4])$/.exec(label);
	return {
		type: match ? "QUARTERLY" : "YEARLY",
		year: match ? Number(match[1]) : createdAt.getUTCFullYear(),
		quarter: match ? Number(match[2]) : null,
	};
}

const updatedAtOf = (row: { createdAt: Date }): Date =>
	(row as { updatedAt?: Date }).updatedAt ?? row.createdAt;

export async function isDealerUser(userId: string): Promise<boolean> {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { userType: true },
	});
	return String(user?.userType) === DEALER_USER_TYPE;
}

// Same response shape as the admin list, limited to the caller's dealership.
export async function listMyAudits(userId: string, query: RawQuery) {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { businessPartnerId: true },
	});
	if (!user?.businessPartnerId) {
		throw new ApiError(403, "You are not linked to a dealership");
	}
	return listAudits(query, user.businessPartnerId);
}

/** Pass businessPartnerId to get the dealer's view of their own audits. */
export async function listAudits(
	query: RawQuery,
	businessPartnerId?: string,
	onlyAuditId?: string,
) {
	const page = Math.max(1, queryInt(query.page, "page") ?? 1);
	const pageSize = Math.min(
		MAX_PAGE_SIZE,
		Math.max(1, queryInt(query.page_size, "page_size") ?? DEFAULT_PAGE_SIZE),
	);
	const sortBy: SortField = SORT_FIELDS.includes(query.sort_by as SortField)
		? (query.sort_by as SortField)
		: "updatedAt";
	const direction = query.sort_order === "asc" ? 1 : -1;
	const search = queryText(query.search).toLowerCase();
	const statuses = queryText(query.status).split(",").filter(Boolean);

	// Step 1: light rows for search + sort, so dealer name, dealer code and the
	// derived audit number all behave the same way.
	const rows = await prisma.dealerAuditInstance.findMany({
		where: {
			...(onlyAuditId ? { id: onlyAuditId } : {}),
			...(businessPartnerId ? { businessPartnerId } : {}),
			...(await periodWhere(query)),
			...(statuses.length ? { status: { in: statuses } } : {}),
		},
		include: {
			businessPartner: { select: { bpName: true, bpShortName: true } },
		},
	});

	const cycleIds = [
		...new Set(rows.flatMap((r) => (r.cycleId ? [r.cycleId] : []))),
	];
	const cycles = await prisma.dealerAuditCycle.findMany({
		where: { id: { in: cycleIds } },
		select: {
			id: true,
			periodType: true,
			periodYear: true,
			periodQuarter: true,
		},
	});
	const cycleById = new Map(cycles.map((c) => [c.id, c]));

	const prepared = rows.map((row) => {
		const period = resolvePeriod(
			row.cycleId ? cycleById.get(row.cycleId) : undefined,
			row.periodLabel,
			row.createdAt,
		);
		return { row, period, number: auditNumber(row.id, period.year) };
	});

	const matched = search
		? prepared.filter(({ row, number }) =>
				[row.businessPartner.bpName, row.businessPartner.bpShortName, number]
					.filter(Boolean)
					.some((value) => value!.toLowerCase().includes(search)),
			)
		: prepared;

	matched.sort((a, b) => {
		let result = 0;
		if (sortBy === "dealerName") {
			result = a.row.businessPartner.bpName.localeCompare(
				b.row.businessPartner.bpName,
			);
		} else if (sortBy === "status") {
			result = String(a.row.status).localeCompare(String(b.row.status));
		} else {
			const left = sortBy === "dueAt" ? a.row.dueAt : updatedAtOf(a.row);
			const right = sortBy === "dueAt" ? b.row.dueAt : updatedAtOf(b.row);
			// Audits without a date always go last.
			if (!left || !right) return Number(!left) - Number(!right);
			result = left.getTime() - right.getTime();
		}
		return result * direction || a.row.id.localeCompare(b.row.id);
	});

	const pageRows = matched.slice((page - 1) * pageSize, page * pageSize);

	// Step 2: heavy relations only for the rows on this page.
	const [details, reviewers] = await Promise.all([
		prisma.dealerAuditInstance.findMany({
			where: { id: { in: pageRows.map((p) => p.row.id) } },
			include: {
				template: { include: { items: true } },
				responses: true,
				businessPartner: {
					include: {
						addresses: { orderBy: { isDefault: "desc" }, take: 1 },
					},
				},
			},
		}),
		prisma.user.findMany({
			where: {
				id: {
					in: pageRows.flatMap((p) =>
						p.row.reviewerId ? [p.row.reviewerId] : [],
					),
				},
			},
			select: { id: true, first_name: true, last_name: true },
		}),
	]);
	const detailById = new Map(details.map((d) => [d.id, d]));
	const reviewerById = new Map(reviewers.map((r) => [r.id, r]));

	const data = pageRows.flatMap(({ row, period, number }) => {
		const detail = detailById.get(row.id);
		if (!detail) return [];

		const latest = new Map<string, (typeof detail.responses)[number]>();
		for (const response of detail.responses) {
			const current = latest.get(response.itemId);
			if (!current || response.iteration > current.iteration) {
				latest.set(response.itemId, response);
			}
		}
		const responses = [...latest.values()];
		const scored = responses.filter((r) => r.dealerScore != null);
		// Dealers never see who is reviewing them.
		const reviewer =
			!businessPartnerId && row.reviewerId
				? reviewerById.get(row.reviewerId)
				: undefined;

		return [
			{
				id: row.id,
				audit_number: number,
				dealer_id: row.businessPartnerId,
				dealer_code: detail.businessPartner.bpShortName,
				dealer_name: detail.businessPartner.bpName,
				location: detail.businessPartner.addresses[0]?.city ?? null,
				facility_type: row.officeType,
				template_name: detail.template.name,
				template_version: detail.template.version,
				period_type: period.type,
				period_year: period.year,
				period_quarter: period.quarter,
				status: row.status,
				assigned_reviewer: reviewer
					? { id: reviewer.id, name: fullName(reviewer) || reviewer.id }
					: null,
				due_at: row.dueAt?.toISOString() ?? null,
				completed_items: scored.length,
				total_items: detail.template.items.length,
				self_score: scored.length
					? scored.reduce((sum, r) => sum + Number(r.dealerScore), 0)
					: null,
				final_score: row.finalScore ?? null,
				max_score: Number(
					row.maxScore ??
						detail.template.items.reduce(
							(sum, item) => sum + Number(item.maxScore ?? 0),
							0,
						),
				),
				final_score_source:
					row.finalScore == null
						? "PENDING"
						: responses.some((r) => r.reviewerScore != null)
							? "REVIEWER"
							: "SELF_AUTO",
				open_clarification_count: responses.filter(
					(r) => String(r.reviewStatus) === "CLARIFICATION_REQUESTED",
				).length,
				updated_at: updatedAtOf(row).toISOString(),
			},
		];
	});

	return {
		data,
		meta: {
			page,
			page_size: pageSize,
			total_items: matched.length,
			total_pages: Math.ceil(matched.length / pageSize),
		},
	};
}

export async function getTrackerSummary(query: RawQuery) {
	const audits = await prisma.dealerAuditInstance.findMany({
		where: {
			...(await periodWhere(query)),
			status: { not: AUDIT_STATUS.CANCELLED },
		},
		select: { status: true, dueAt: true, finalScore: true, maxScore: true },
	});

	const count = (...statuses: AuditStatus[]) =>
		audits.filter((a) => statuses.includes(a.status as AuditStatus)).length;
	const percents = audits.flatMap((a) =>
		a.finalScore != null && Number(a.maxScore) > 0
			? [(Number(a.finalScore) / Number(a.maxScore)) * 100]
			: [],
	);
	const now = Date.now();

	return {
		total: audits.length,
		not_started: count(AUDIT_STATUS.DRAFT),
		in_progress: count(
			AUDIT_STATUS.IN_PROGRESS,
			AUDIT_STATUS.RECTIFICATION_IN_PROGRESS,
		),
		awaiting_review: count(
			AUDIT_STATUS.SUBMITTED,
			AUDIT_STATUS.UNDER_REVIEW,
			AUDIT_STATUS.RESUBMITTED,
		),
		clarification: count(AUDIT_STATUS.CLARIFICATION_REQUIRED),
		awaiting_approval: count(AUDIT_STATUS.PENDING_APPROVAL),
		closed: count(
			AUDIT_STATUS.APPROVED,
			AUDIT_STATUS.IMPROVEMENT_REQUIRED,
			AUDIT_STATUS.CLOSED,
		),
		overdue: audits.filter(
			(a) =>
				a.dueAt &&
				a.dueAt.getTime() < now &&
				!FINISHED_AUDIT_STATUSES.includes(a.status as AuditStatus),
		).length,
		average_score_percent: percents.length
			? Math.round(
					(percents.reduce((sum, p) => sum + p, 0) / percents.length) * 10,
				) / 10
			: null,
	};
}

// ─────────────────────────────────────────────
// One audit + its checklist
//
//   GET /dealer-audit/audits/:id             getAudit
//   GET /dealer-audit/audits/:id/checklist   getAuditChecklist
//
// Dealer logins can only open their own dealership's audits (anything else is
// "not found") and never receive the reviewer's identity, scores or decisions.
// ─────────────────────────────────────────────

const RESPONSE_EVIDENCE_TYPE = "DEALER_ITEM_RESPONSE";

/** undefined = internal user (no dealership restriction). */
async function dealerScopeOf(userId: string): Promise<string | undefined> {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { userType: true, businessPartnerId: true },
	});
	if (String(user?.userType) !== DEALER_USER_TYPE) return undefined;
	if (!user?.businessPartnerId) {
		throw new ApiError(403, "You are not linked to a dealership");
	}
	return user.businessPartnerId;
}

const isoOrNull = (value: unknown) =>
	value instanceof Date ? value.toISOString() : null;

export async function getAudit(userId: string, auditId: string) {
	const scope = await dealerScopeOf(userId);
	const [summary] = (await listAudits({}, scope, auditId)).data;
	if (!summary) throw new ApiError(404, "Audit not found");

	const row = await prisma.dealerAuditInstance.findUnique({
		where: { id: auditId },
	});
	if (!row) throw new ApiError(404, "Audit not found");
	// Read optional columns defensively: not every one exists on the model yet.
	const extra = row as unknown as Record<string, unknown>;

	return {
		...summary,
		template_id: row.checklistTemplateId,
		created_at: row.createdAt.toISOString(),
		submitted_at: isoOrNull(extra.submittedAt),
		closed_at: isoOrNull(row.closedAt),
		version: typeof extra.version === "number" ? extra.version : 1,
		auto_finalize_at: isoOrNull(extra.autoFinalizeAt),
	};
}

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "general";

export async function getAuditChecklist(userId: string, auditId: string) {
	const scope = await dealerScopeOf(userId);
	const audit = await prisma.dealerAuditInstance.findFirst({
		where: {
			id: auditId,
			...(scope ? { businessPartnerId: scope } : {}),
		},
		include: {
			template: {
				include: {
					items: {
						orderBy: { order: "asc" },
						include: { scoreLevels: { orderBy: { score: "desc" } } },
					},
				},
			},
			responses: true,
			businessPartner: {
				include: { addresses: { orderBy: { isDefault: "desc" }, take: 1 } },
			},
		},
	});
	if (!audit) throw new ApiError(404, "Audit not found");

	const latest = new Map<string, (typeof audit.responses)[number]>();
	for (const response of audit.responses) {
		const current = latest.get(response.itemId);
		if (!current || response.iteration > current.iteration) {
			latest.set(response.itemId, response);
		}
	}

	// Evidence from every round of an item stays visible on that item.
	const itemIdByResponse = new Map(
		audit.responses.map((r) => [r.id, r.itemId]),
	);
	const files = await prisma.evidence.findMany({
		where: {
			subjectType: RESPONSE_EVIDENCE_TYPE as never,
			subjectId: { in: [...itemIdByResponse.keys()] },
		},
	});
	const evidenceByItem = new Map<string, object[]>();
	for (const file of files) {
		const itemId = itemIdByResponse.get(file.subjectId);
		if (!itemId) continue;
		const extra = file as unknown as Record<string, unknown>;
		const url = await getSignedImageUrl(file.s3Key);
		const list = evidenceByItem.get(itemId) ?? [];
		list.push({
			id: file.id,
			url,
			thumbnail_url: null,
			file_name: file.s3Key.split("/").pop() ?? file.id,
			size_bytes: null,
			mime_type: null,
			captured_at:
				isoOrNull(extra.capturedAt ?? extra.createdAt ?? extra.created_at) ??
				audit.createdAt.toISOString(),
			latitude: Number(file.geoLat ?? 0),
			longitude: Number(file.geoLng ?? 0),
			accuracy_m: null,
		});
		evidenceByItem.set(itemId, list);
	}

	type Section = {
		id: string;
		sequence: number;
		name: string;
		items: object[];
	};
	const sections = new Map<string, Section>();

	for (const [index, item] of audit.template.items.entries()) {
		const name = item.functionName || item.sectionName || "General";
		let section = sections.get(name);
		if (!section) {
			section = {
				id: slug(name),
				sequence: sections.size + 1,
				name,
				items: [],
			};
			sections.set(name, section);
		}

		const response = latest.get(item.id);
		const extra = (response ?? {}) as unknown as Record<string, unknown>;
		const answeredAt = isoOrNull(extra.updatedAt ?? extra.createdAt);
		const evidence = evidenceByItem.get(item.id) ?? [];
		const levels = item.scoreLevels.map((l) => ({
			score: Number(l.score),
			criteria: l.criteria,
		}));
		const minEvidence = item.requiresEvidence ? (item.minEvidence ?? 1) : 0;
		const status = response ? String(response.reviewStatus) : "PENDING";
		const needsClarification = status === "CLARIFICATION_REQUESTED";
		const reviewed =
			response &&
			(response.reviewerScore != null ||
				response.reviewerRemark != null ||
				status !== "PENDING");

		section.items.push({
			id: item.id,
			sequence: index + 1,
			section_id: section.id,
			section_name: section.name,
			title: item.label,
			guidance: item.checkPoint ?? item.scoringGuidance ?? null,
			criteria: [],
			category: item.categoryName ?? null,
			function_area: item.functionName ?? null,
			is_scored: item.requiresScore,
			score_levels: levels,
			min_score: levels.length
				? Math.min(...levels.map((l) => l.score))
				: item.requiresScore
					? 0
					: null,
			max_score: item.maxScore == null ? null : Number(item.maxScore),
			evidence_required: item.requiresEvidence,
			min_evidence_count: item.minEvidence,
			max_evidence_count: item.maxEvidence,
			self: response
				? {
						score:
							response.dealerScore == null
								? null
								: Number(response.dealerScore),
						remarks: response.dealerRemark,
						evidence,
						answered_at: answeredAt,
						is_complete:
							(!item.requiresScore || response.dealerScore != null) &&
							evidence.length >= minEvidence,
					}
				: null,
			review:
				!scope && reviewed
					? {
							score:
								response.reviewerScore == null
									? null
									: Number(response.reviewerScore),
							remarks: response.reviewerRemark,
							decision:
								status === "APPROVED"
									? "ACCEPTED"
									: needsClarification
										? "CLARIFICATION_REQUIRED"
										: "PENDING",
							score_change_reason: null,
							reviewed_at: answeredAt,
						}
					: null,
			clarification:
				response && needsClarification
					? {
							id: response.id,
							status: "OPEN",
							remarks: response.reviewerRemark ?? "",
							raised_at: answeredAt ?? audit.createdAt.toISOString(),
							due_at: null,
							response: null,
							responded_at: null,
						}
					: null,
		});
	}

	return {
		audit_id: audit.id,
		dealer_name: audit.businessPartner.bpName,
		dealer_code: audit.businessPartner.bpShortName,
		location: audit.businessPartner.addresses[0]?.city ?? null,
		status: audit.status,
		version: (audit as unknown as { version?: number }).version ?? 1,
		sections: [...sections.values()],
	};
}

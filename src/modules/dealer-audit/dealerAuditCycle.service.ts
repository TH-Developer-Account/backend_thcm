import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

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

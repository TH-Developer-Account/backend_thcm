// Dealer Audit: notifications and the daily deadline job.
//
// Rules:
//   1. Dealer has not submitted by the due date      -> audit closes with 0.
//   2. Reviewer has not finished by the review date  -> dealer's score is final.
//      The reviewer is reminded 7, 3 and 1 days before; an audit is never
//      auto-finalised unless a reminder went out on an earlier day.
//   3. Dealer has not answered a clarification       -> reviewer's score is final.
// Review date = end of the audit's fiscal quarter (April start), but never less
// than 7 days after the dealer submitted.

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { addMailJob } from "@kernel/mail/mail.service";
import { notify } from "@notifications/notification.services";
import { runBatchJob } from "@shared/jobs/batchRunner";
import { Prisma } from "../../prisma/generated/prisma/client";
import { AUDIT_STATUS, AuditStatus } from "./dealerAuditCycle.service";

const DAY = 86_400_000;
const REMIND_DAYS = [7, 3, 1];
const MIN_REVIEW_DAYS = 7;

// ─────────────────────────────────────────────
// Notifications (in-app + email). Never fail the caller.
// ─────────────────────────────────────────────

async function send(
	auditId: string,
	audience: "DEALER" | "REVIEWER",
	title: string,
	message: string,
) {
	try {
		const audit = await prisma.dealerAuditInstance.findUnique({
			where: { id: auditId },
			select: {
				workspaceId: true,
				periodLabel: true,
				reviewer: { select: { id: true, email: true } },
				businessPartner: {
					select: {
						bpName: true,
						users: {
							where: { isDefaultContact: true, is_active: true },
							select: { id: true, email: true },
							take: 1,
						},
					},
				},
			},
		});
		const recipient =
			audience === "DEALER"
				? audit?.businessPartner.users[0]
				: audit?.reviewer;
		if (!audit || !recipient) return;

		const label = `Dealer Audit — ${audit.businessPartner.bpName} (${audit.periodLabel})`;
		const link = `/dealer-audit/${auditId}`;
		await notify({
			workspaceId: audit.workspaceId,
			recipientId: recipient.id,
			type: "GENERIC",
			title,
			body: `${label}: ${message}`,
			link,
			metadata: { appKey: "DEALER_AUDIT", subjectId: auditId },
		});
		if (recipient.email) {
			await addMailJob({
				to: recipient.email,
				subject: `${title} - ${label}`,
				templateName: "dealer-audit-notice",
				templateData: {
					title,
					message,
					subjectLabel: label,
					dashboardUrl: `${process.env.FRONTEND_URL ?? ""}${link}`,
				},
			});
		}
	} catch (error) {
		logger.error(
			`[DealerAudit] Could not notify ${audience} for ${auditId}: ${(error as Error).message}`,
		);
	}
}

export const notifyDealer = (auditId: string, title: string, message: string) =>
	send(auditId, "DEALER", title, message);

export const notifyReviewer = (
	auditId: string,
	title: string,
	message: string,
) => send(auditId, "REVIEWER", title, message);

// ─────────────────────────────────────────────
// Dates (India time)
// ─────────────────────────────────────────────

const endOfDayIndia = (year: number, month: number, day: number) =>
	new Date(Date.UTC(year, month, day, 18, 29, 59));

// periodYear is the year the fiscal year starts. Q1 = Apr-Jun.
function periodEnd(
	cycle: { periodYear: number; periodQuarter: number | null } | null,
) {
	if (!cycle) return null;
	const quarter = cycle.periodQuarter ?? 4;
	// Day 0 of the month after the quarter = last day of the quarter.
	return endOfDayIndia(cycle.periodYear, 3 + quarter * 3, 0);
}

const indiaDate = (date: Date) =>
	new Date(date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

const daysUntil = (date: Date, now: Date) =>
	Math.round(
		(Date.parse(indiaDate(date)) - Date.parse(indiaDate(now))) / DAY,
	);

// ─────────────────────────────────────────────
// Closing
// ─────────────────────────────────────────────

const JOB_INCLUDE = {
	cycle: { select: { periodYear: true, periodQuarter: true } },
	template: { include: { items: true } },
	responses: { orderBy: { iteration: "asc" as const } },
} satisfies Prisma.DealerAuditInstanceInclude;

type JobAudit = Prisma.DealerAuditInstanceGetPayload<{
	include: typeof JOB_INCLUDE;
}>;

async function close(
	audit: JobAudit,
	source: "ZERO" | "DEALER" | "REVIEWER",
) {
	// Ordered by iteration, so the last row per item wins.
	const latest = new Map(audit.responses.map((r) => [r.itemId, r]));
	let finalScore = 0;
	let maxScore = 0;
	for (const item of audit.template.items) {
		if (!item.requiresScore) continue;
		maxScore += item.maxScore ?? 0;
		const response = latest.get(item.id);
		if (source === "ZERO" || !response) continue;
		// A dealer who answered a clarification has no reviewer score on the new
		// round yet, so their own score stands for that item.
		if (source === "REVIEWER" && response.isNotApplicable) continue;
		finalScore +=
			source === "DEALER"
				? (response.dealerScore ?? 0)
				: (response.reviewerScore ?? response.dealerScore ?? 0);
	}

	const action =
		source === "ZERO" ? "DEALER_AUDIT_EXPIRED" : "DEALER_AUDIT_AUTO_FINALIZED";
	const now = new Date();

	return prisma.$transaction(async (tx) => {
		const moved = await tx.dealerAuditInstance.updateMany({
			where: { id: audit.id, status: audit.status },
			data: {
				status: AUDIT_STATUS.CLOSED,
				finalScore,
				maxScore,
				closedAt: now,
				clarificationDueAt: null,
				// escalatedAt marks "dealer's score was taken automatically".
				escalatedAt: source === "DEALER" ? now : null,
			},
		});
		if (moved.count !== 1) return false;
		await tx.activityLog.create({
			data: {
				action,
				subjectType: "DEALER_AUDIT_INSTANCE",
				subjectId: audit.id,
				metadata: { source, finalScore, maxScore },
			},
		});
		return true;
	});
}

// Sends at most one reminder per audit per day.
async function remind(
	audit: JobAudit,
	audience: "DEALER" | "REVIEWER",
	deadline: Date,
	now: Date,
	message: string,
) {
	const left = daysUntil(deadline, now);
	// A passed deadline with no earlier reminder still gets one warning first.
	const due = REMIND_DAYS.includes(left) || (left <= 0 && !audit.lastReminderAt);
	if (!due) return false;
	if (audit.lastReminderAt && indiaDate(audit.lastReminderAt) === indiaDate(now))
		return false;
	await send(
		audit.id,
		audience,
		"Dealer Audit reminder",
		`${message} Due: ${indiaDate(deadline)}.`,
	);
	await prisma.dealerAuditInstance.update({
		where: { id: audit.id },
		data: { lastReminderAt: now },
	});
	return true;
}

const WITH_DEALER: AuditStatus[] = [
	AUDIT_STATUS.DRAFT,
	AUDIT_STATUS.IN_PROGRESS,
];
const WITH_REVIEWER: AuditStatus[] = [
	AUDIT_STATUS.SUBMITTED,
	AUDIT_STATUS.UNDER_REVIEW,
	AUDIT_STATUS.RESUBMITTED,
];

async function processAudit(audit: JobAudit, now: Date) {
	const status = audit.status as AuditStatus;

	if (WITH_DEALER.includes(status)) {
		if (!audit.dueAt) return "skipped" as const;
		if (audit.dueAt < now) {
			if (!(await close(audit, "ZERO"))) return "skipped" as const;
			await notifyDealer(
				audit.id,
				"Audit closed",
				"It was not submitted by the due date, so the score is 0.",
			);
			return "created" as const;
		}
		await remind(
			audit,
			"DEALER",
			audit.dueAt,
			now,
			"Submit your self-assessment, or the audit will score 0.",
		);
		return "skipped" as const;
	}

	if (status === AUDIT_STATUS.CLARIFICATION_REQUIRED) {
		if (!audit.clarificationDueAt) return "skipped" as const;
		if (audit.clarificationDueAt < now) {
			if (!(await close(audit, "REVIEWER"))) return "skipped" as const;
			await notifyDealer(
				audit.id,
				"Audit closed",
				"The clarification was not answered in time, so the reviewer's score is final.",
			);
			return "created" as const;
		}
		await remind(
			audit,
			"DEALER",
			audit.clarificationDueAt,
			now,
			"Answer the clarification, or the reviewer's score becomes final.",
		);
		return "skipped" as const;
	}

	const minimum = new Date(
		(audit.submittedAt ?? audit.updatedAt).getTime() + MIN_REVIEW_DAYS * DAY,
	);
	const end = periodEnd(audit.cycle) ?? audit.dueAt;
	const deadline = end && end > minimum ? end : minimum;
	// The reviewer has submitted at least once (waiting to be sent for approval,
	// or returned by an approver): the review was done, so it is only chased.
	const reviewed = await prisma.activityLog.count({
		where: {
			subjectType: "DEALER_AUDIT_INSTANCE",
			subjectId: audit.id,
			action: "DEALER_AUDIT_REVIEW_SUBMITTED",
		},
	});
	if (reviewed) {
		await remind(
			audit,
			"REVIEWER",
			deadline,
			now,
			"Finish your review and send the audit for approval.",
		);
		return "skipped" as const;
	}
	const warned =
		!!audit.lastReminderAt &&
		indiaDate(audit.lastReminderAt) < indiaDate(now);

	if (deadline < now && warned) {
		if (!(await close(audit, "DEALER"))) return "skipped" as const;
		const message =
			"The review was not completed in time, so the dealer's score is final.";
		await notifyReviewer(audit.id, "Audit auto-finalised", message);
		await notifyDealer(audit.id, "Audit closed", message);
		return "created" as const;
	}
	await remind(
		audit,
		"REVIEWER",
		deadline,
		now,
		"Complete your review, or the dealer's score becomes final.",
	);
	return "skipped" as const;
}

export async function runDealerAuditDeadlines(now = new Date()) {
	const audits = await prisma.dealerAuditInstance.findMany({
		where: {
			status: {
				in: [
					...WITH_DEALER,
					...WITH_REVIEWER,
					AUDIT_STATUS.CLARIFICATION_REQUIRED,
				],
			},
		},
		include: JOB_INCLUDE,
	});
	const summary = await runBatchJob(
		audits,
		(audit) => audit.id,
		(audit) => processAudit(audit, now),
	);
	logger.info(
		`Dealer audit deadlines: ${summary.succeeded} closed, ${summary.failed} failed of ${summary.attempted}`,
		summary.failed ? { failures: summary.failures } : undefined,
	);
	return summary;
}

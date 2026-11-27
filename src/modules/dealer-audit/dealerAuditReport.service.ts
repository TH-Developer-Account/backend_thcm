// Dealer Audit: report PDF and report email.
// Kept free of read/write service imports because the workflow helper calls it
// after final approval.

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import ApiError from "@shared/utils/apiError";
import { uploadToS3, getSignedImageUrl } from "@shared/utils/aws-s3.services";
import { renderPdfBuffer } from "@kernel/pdf/pdfRenderEngine";
import { addMailJob } from "@kernel/mail/mail.service";
import { notify } from "@notifications/notification.services";
import { assembleDealerAuditPdfData } from "./dealerAuditAssembler";
import { buildDealerAuditDocDefinition } from "./dealerAuditDocDefination";

// Long enough to survive mail retries.
const ATTACHMENT_URL_SECONDS = 60 * 60 * 24;

const reportKey = (auditId: string) => `dealer-audit-reports/${auditId}.pdf`;

// Always renders from current data, so a cached PDF can never be stale.
export async function createReportPdf(auditId: string) {
	const data = await assembleDealerAuditPdfData(auditId);
	const buffer = await renderPdfBuffer(buildDealerAuditDocDefinition(data));
	const key = reportKey(auditId);
	await uploadToS3(key, buffer, "application/pdf");
	return { key, data };
}

export const reportUrl = (key: string, seconds?: number) =>
	getSignedImageUrl(key, seconds);

// Default: to the dealer's primary contact, cc the reviewer.
// With `recipients` (resend): only to those addresses.
export async function sendReportMail(auditId: string, recipients?: string[]) {
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
	if (!audit) throw new ApiError(404, "Audit not found");

	const dealer = audit.businessPartner.users[0];
	const reviewerEmail = audit.reviewer?.email;
	const to = recipients?.length
		? recipients
		: [dealer?.email ?? reviewerEmail].filter((e): e is string => !!e);
	if (!to.length) {
		throw new ApiError(422, "There is no email address to send the report to");
	}
	const cc =
		!recipients?.length && dealer?.email && reviewerEmail
			? reviewerEmail
			: undefined;

	const { key, data } = await createReportPdf(auditId);
	const label = `Dealer Audit — ${audit.businessPartner.bpName} (${audit.periodLabel})`;
	const link = `/dealer-audit/${auditId}`;

	await addMailJob({
		to,
		cc,
		subject: `Audit report - ${label}`,
		templateName: "dealer-audit-report",
		templateData: {
			subjectLabel: label,
			score: `${data.totalScore} / ${data.maxScore}`,
			percent: data.percent,
			dashboardUrl: `${process.env.FRONTEND_URL ?? ""}${link}`,
		},
		attachments: [
			{
				filename: `dealer-audit-${audit.periodLabel.replace(/[^\w-]+/g, "-")}.pdf`,
				path: await reportUrl(key, ATTACHMENT_URL_SECONDS),
			},
		],
	});
	const sentAt = new Date();
	await prisma.dealerAuditInstance.update({
		where: { id: auditId },
		data: { reportSentAt: sentAt },
	});

	if (!recipients?.length) {
		const users = [dealer?.id, audit.reviewer?.id].filter(
			(id): id is string => !!id,
		);
		for (const recipientId of users) {
			try {
				await notify({
					workspaceId: audit.workspaceId,
					recipientId,
					type: "GENERIC",
					title: "Audit approved",
					body: `${label}: the report is ready.`,
					link,
					metadata: { appKey: "DEALER_AUDIT", subjectId: auditId },
				});
			} catch (error) {
				logger.error(
					`[DealerAudit] Report notification failed for ${auditId}: ${(error as Error).message}`,
				);
			}
		}
	}
	return { sentAt, recipientCount: to.length };
}

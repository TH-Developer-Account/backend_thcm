// cpp.mail.ts — the "CPP approved" mail to TCS, CC the proposer.
//
// Called from the workflow's final-approval hook (workflowSubject.helper.ts, subject type
// CPP_REQUEST) after the approval transaction has committed, so it reads through the shared
// prisma client and never takes a transaction.
//
//   To   everyone in the TCS role of the approval matrix (and only them)
//   CC   the proposer (sendWorkflowMail adds the initiator as CC)
//   Att. the CPP PDF + ZINFOUPDATE_ME11 + ZCHANGEINFO text files (built in cpp.export.service.ts)
//
// The mail never throws: an approval must not fail because a mail could not be sent. A file
// that cannot be built is left out and the mail says why.
import { createHash } from "crypto";

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { sendWorkflowMail } from "@kernel/mail/workFlowEmail.services";
import { issueAccessToken } from "@shared/services/accessToken.services";

import { CPP_SUBJECT_TYPE, CPP_TCS_ROLE_KEY } from "./cpp.constants";
import { buildCppTextAttachments, renderCppPdf } from "./cpp.export.service";
import { fullName, recommendedSupplierOf, safeFileName, str } from "./cpp.helper";

const TEMPLATE_NAME = "cpp-approved";

/** Nodemailer attachment shape; base64 so it survives the mail queue as JSON. */
export type CppMailAttachment = {
	filename: string;
	content: string;
	encoding: "base64";
	contentType: string;
};

type MailFile = { name: string; description: string; sha256?: string };

const sha256 = (content: string | Buffer) =>
	createHash("sha256").update(content).digest("hex");

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const istDate = (date: Date) =>
	new Intl.DateTimeFormat("en-IN", {
		timeZone: "Asia/Kolkata",
		day: "2-digit",
		month: "short",
		year: "numeric",
	}).format(date);

/** Active users in the TCS role of the request's workspace, in matrix order, with an email. */
const tcsRecipients = async (workspaceId: string) => {
	const seats = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId, roleKey: CPP_TCS_ROLE_KEY, scope: "ALL" },
		orderBy: { position: "asc" },
		select: { userId: true },
	});
	const ids = seats.map((s) => s.userId);
	if (ids.length === 0) return [];
	const users = await prisma.user.findMany({
		where: { id: { in: ids }, is_active: true },
		select: { id: true, first_name: true, last_name: true, email: true },
	});
	return ids
		.map((id) => users.find((u) => u.id === id))
		.filter((u): u is (typeof users)[number] => Boolean(u && str(u.email)));
};

export const sendCppApprovedMail = async (requestId: string): Promise<void> => {
	try {
		const cpp = await prisma.cppRequest.findUnique({
			where: { id: requestId },
			select: {
				id: true,
				workspaceId: true,
				referenceNumber: true,
				category: true,
				plant: true,
				condition: true,
				initiatedById: true,
				sections: true,
			},
		});
		if (!cpp) {
			logger.error(`[CppMail] CPP ${requestId} not found; approved mail skipped`);
			return;
		}

		const recipients = await tcsRecipients(cpp.workspaceId);
		if (recipients.length === 0) {
			logger.warn(
				`[CppMail] Nobody with an email is in the TCS role; approved mail for ${cpp.referenceNumber} not sent`,
			);
			return;
		}

		const proposer = await prisma.user.findUnique({
			where: { id: cpp.initiatedById },
			select: { first_name: true, last_name: true },
		});
		const supplier = recommendedSupplierOf(cpp.sections);

		/* ---- files: each one is optional, the mail goes out regardless ---- */
		const attachments: CppMailAttachment[] = [];
		const files: MailFile[] = [];
		const problems: string[] = [];

		try {
			const { buffer } = await renderCppPdf(cpp.id);
			const name = `CPP-${safeFileName(cpp.referenceNumber)}.pdf`;
			attachments.push({
				filename: name,
				content: buffer.toString("base64"),
				encoding: "base64",
				contentType: "application/pdf",
			});
			files.push({
				name,
				description:
					"Price approval form, summary sheet, approval workflow and audit trail",
			});
		} catch (error) {
			logger.error(
				`[CppMail] PDF for ${cpp.referenceNumber} failed: ${errorText(error)}`,
			);
			problems.push("The PDF could not be generated. Download it from the CPP request.");
		}

		try {
			for (const text of await buildCppTextAttachments(cpp.id)) {
				attachments.push({
					filename: text.fileName,
					content: Buffer.from(text.content, "utf8").toString("base64"),
					encoding: "base64",
					contentType: "text/plain; charset=utf-8",
				});
				files.push({
					name: text.fileName,
					description: text.fileName.startsWith("ZINFOUPDATE_ME11")
						? "SAP ME11 upload: new price (with tax code)"
						: "SAP upload: price change (without tax code)",
					sha256: sha256(text.content),
				});
			}
		} catch (error) {
			logger.error(
				`[CppMail] Text files for ${cpp.referenceNumber} failed: ${errorText(error)}`,
			);
			problems.push(`The SAP text files could not be generated: ${errorText(error)}`);
		}

		// Long-lived view token, same as the vendor onboarding mail: the TCS team opens
		// the PDF and the text files from the links without logging in.
		const viewToken = await issueAccessToken(
			CPP_SUBJECT_TYPE,
			cpp.id,
			prisma,
			"VIEW_PDF",
		);
		const publicUrl = (path: string) =>
			`${process.env.BACKEND_URL}/api/v1/cpp/public/${path}`;

		const payload = {
			to: recipients.map((u) => str(u.email)).join(","),
			subject: `CPP ${cpp.referenceNumber} approved: files for SAP upload`,
			templateName: TEMPLATE_NAME,
			templateData: {
				recipientName:
					recipients.length === 1 ? fullName(recipients[0]) || "TCS team" : "TCS team",
				referenceNo: cpp.referenceNumber,
				category: cpp.category ?? "",
				plant: cpp.plant ?? "",
				condition: cpp.condition ?? "",
				supplierName: supplier.name,
				supplierCode: supplier.code,
				proposerName: proposer ? fullName(proposer) : "",
				approvedOn: istDate(new Date()),
				files,
				hasChecksums: files.some((f) => f.sha256),
				problems,
				pdfViewUrl: publicUrl(`pdf/${viewToken.token}`),
				me11Url: publicUrl(`text/${viewToken.token}?file=me11`),
				changeInfoUrl: publicUrl(`text/${viewToken.token}?file=changeinfo`),
				dashboardUrl: `${process.env.FRONTEND_URL ?? ""}/cpp/${cpp.id}/view`,
			},
			attachments,
		};

		// `attachments` needs the MailJobPayload change described in the CPP notes
		// (kernel mail queue). Until then the mail is sent without the files.
		await sendWorkflowMail(
			payload as unknown as Parameters<typeof sendWorkflowMail>[0],
			cpp.initiatedById, // sendWorkflowMail CCs the proposer
		);
		logger.info(
			`[CppMail] Approved mail for ${cpp.referenceNumber} sent to ${recipients.length} TCS user(s) with ${attachments.length} file(s)`,
		);
	} catch (error) {
		logger.error(
			`[CppMail] Approved mail for ${requestId} failed: ${errorText(error)}`,
		);
	}
};

/** Older name, kept for the final-approval hook that may still call it. */
export const notifyCppApproved = sendCppApprovedMail;

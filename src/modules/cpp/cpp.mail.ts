// cpp/cpp.mail.ts — CPP approved mail to TCS, CC the proposer.
// Called from the workflow's final-approval hook (workflowSubject.helper.ts,
// subject type CPP_REQUEST), after the approval transaction has committed.
import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { sendWorkflowMail } from "@kernel/mail/workFlowEmail.services";

const TCS_EMAIL = process.env.CPP_TCS_EMAIL;

const asObject = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const str = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

export const sendCppApprovedMail = async (requestId: string): Promise<void> => {
	if (!TCS_EMAIL) {
		logger.error(
			`[CppMail] CPP_TCS_EMAIL is not set; approved mail for ${requestId} skipped`,
		);
		return;
	}

	const cpp = await prisma.cppRequest.findUnique({
		where: { id: requestId },
		include: { attachments: { orderBy: { uploadedAt: "asc" } } },
	});
	if (!cpp) {
		logger.error(`[CppMail] CPP ${requestId} not found; approved mail skipped`);
		return;
	}

	const proposer = await prisma.user.findUnique({
		where: { id: cpp.initiatedById },
		select: { first_name: true, last_name: true },
	});

	// `sections` is a JSON array of { key, data }. Supplier details live under
	// the "purchasing" section, as suppliers.recommended.{name, code}.
	const sections = Array.isArray(cpp.sections) ? cpp.sections : [];
	const sectionData = (key: string) =>
		asObject(asObject(sections.find((s) => asObject(s).key === key)).data);
	const recommended = asObject(
		asObject(sectionData("purchasing").suppliers).recommended,
	);

	await sendWorkflowMail(
		{
			to: TCS_EMAIL,
			subject: `CPP ${cpp.referenceNumber} approved`,
			templateName: "cpp-approved",
			templateData: {
				recipientName: "TCS team",
				referenceNo: cpp.referenceNumber,
				category: cpp.category ?? "",
				plant: cpp.plant ?? "",
				condition: cpp.condition ?? "",
				supplierName: str(recommended.name),
				supplierCode: str(recommended.code),
				proposerName: [proposer?.first_name, proposer?.last_name]
					.filter(Boolean)
					.join(" "),
				approvedOn: new Date().toLocaleDateString("en-IN"),
				attachments: cpp.attachments.map((a) => a.fileName),
				// CONFIRM the frontend route for a CPP view page.
				dashboardUrl: `${process.env.FRONTEND_URL ?? ""}/cpp/${cpp.id}`,
			},
			// TODO: the generated PDF, Excel and text exports, plus cpp.attachments,
			// must be attached here. MailJobPayload has no attachments field yet.
		},
		cpp.initiatedById, // sendWorkflowMail CCs the proposer
	);
};

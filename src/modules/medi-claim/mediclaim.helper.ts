import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "@shared/config/prisma";
import { addMailJob } from "@mail/mail.service";

type Tx = Prisma.TransactionClient;

// ── constants ──────────────────────────────────────────────────────────────
const CLAIM_INITIATION_STATUS = "AWAITING_EX_EMPLOYEE";

const INITIATION_SEARCH_FIELDS = ["employeeName", "email", "mobile"] as const;
const CLAIM_SEARCH_FIELDS = [
	"employeeName",
	"ticketNumber",
	"referenceNumber",
] as const;

export type MedicalClaimListingTab =
	| "initiation"
	| "claims"
	| "pendingOnMe"
	| "approvedByMe";

export async function resolveMedicalClaimSubjectIdsForApprovalTab(
	userId: string,
	tab: Extract<MedicalClaimListingTab, "pendingOnMe" | "approvedByMe">,
): Promise<string[]> {
	const approvals = await prisma.approval.findMany({
		where: {
			approverId: userId,
			status: tab === "pendingOnMe" ? "PENDING" : "APPROVED",
			stage: {
				workflow: { subjectType: "MEDICAL_CLAIM", isActive: true },
				...(tab === "pendingOnMe"
					? { isCurrentIteration: true, status: "IN_PROGRESS" }
					: {}),
			},
		},
		select: {
			stage: { select: { workflow: { select: { subjectId: true } } } },
		},
	});

	return [...new Set(approvals.map((a) => a.stage.workflow.subjectId))];
}

export const buildMedicalClaimWhereClause = (
	workspaceId: string,
	userId: string,
	tab: MedicalClaimListingTab,
	search: string,
	approvalSubjectIds?: string[],
) => {
	const searchableFields =
		tab === "initiation" ? INITIATION_SEARCH_FIELDS : CLAIM_SEARCH_FIELDS;

	const searchFilter = search
		? {
				OR: searchableFields.map((field) => ({
					[field]: { contains: search, mode: "insensitive" as const },
				})),
			}
		: {};

	if (tab === "pendingOnMe" || tab === "approvedByMe") {
		return {
			workspaceId,
			id: { in: approvalSubjectIds ?? [] },
			...searchFilter,
		};
	}

	const statusFilter =
		tab === "initiation"
			? { status: CLAIM_INITIATION_STATUS }
			: { status: { not: CLAIM_INITIATION_STATUS } };

	return {
		workspaceId,
		initiatedById: userId,
		...statusFilter,
		...searchFilter,
	};
};

export const parseMedicalClaimListingPaginationParams = (
	page_index: string,
	page_size: string,
) => {
	const reqPageIndex = Math.max(0, parseInt(page_index as string, 10) || 0);
	const reqPageSize = Math.min(
		100,
		Math.max(1, parseInt(page_size as string, 10) || 10),
	);

	return { reqPageIndex, reqPageSize };
};

// Format: MED-<4-letter employee code>-<timestamp>, e.g. MED-SYED-20260811143205
// Mirrors generateVendorOnboardingReferenceNumber exactly.
export function generateMedicalClaimReferenceNumber(
	employeeName: string,
): string {
	const letters = employeeName.replace(/[^a-zA-Z]/g, "").toUpperCase();
	const code = (letters + "XXXX").slice(0, 4);

	const timestamp = new Date()
		.toISOString()
		.replace(/[-:T.]/g, "")
		.slice(0, 14);

	return `MED-${code}-${timestamp}`;
}

// Server-side only — never trust a client-submitted eligible/settled amount.
// Shared between submitMedicalClaimForm and resubmitGuestMedicalClaim so the
// calculation can't drift between the two call sites.
export async function computeMedicalClaimEligibility(
	tx: Tx,
	guestId: string,
	grade: string,
	excludeClaimId?: string,
) {
	const eligibility = await tx.medicalClaimGradeEligibility.findUnique({
		where: { grade },
	});
	if (!eligibility) return null;

	const currentYearStart = new Date(new Date().getFullYear(), 0, 1);
	const priorApprovedBills = await tx.medicalClaimBill.aggregate({
		where: {
			claim: {
				guestId,
				status: "APPROVED",
				created_at: { gte: currentYearStart },
				...(excludeClaimId ? { id: { not: excludeClaimId } } : {}),
			},
		},
		_sum: { approvedClaimAmount: true },
	});
	const alreadySettled = Number(
		priorApprovedBills._sum.approvedClaimAmount ?? 0,
	);
	const eligibleAmount = Number(eligibility.annualCap) - alreadySettled;

	return { eligibleAmount, alreadySettled };
}

// Called from workflowSubject.helper's postClarifyHooks when an approver
// clarifies a MEDICAL_CLAIM — the only path back to the ex-employee.
export async function notifyGuestOfClarification(
	tx: Tx,
	claimId: string,
): Promise<void> {
	const claim = await tx.medicalClaim.findUnique({
		where: { id: claimId },
		select: {
			guestId: true,
			referenceNumber: true,
			email: true,
			employeeName: true,
		},
	});
	if (!claim?.guestId) return;

	await addMailJob({
		to: claim.email as string,
		subject: "Medical Claim — Clarification Requested",
		templateName: "medical-claim-clarification",
		templateData: {
			employeeName: claim.employeeName,
			referenceNumber: claim.referenceNumber,
			loginUrl: `${process.env.FRONTEND_URL}/guest/login`,
		},
	});
}

// Bills can carry any common receipt/photo format — broader than vendor
// onboarding's fixed cert types, so this stays local rather than importing
// the vendor-doc-specific mime map.
const BILL_ATTACHMENT_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"application/pdf": "pdf",
};

export function getBillAttachmentExtension(mimetype: string): string {
	return BILL_ATTACHMENT_EXTENSIONS_BY_MIME_TYPE[mimetype] ?? "bin";
}

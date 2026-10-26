import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "@shared/config/prisma";
import { sendWorkflowMail } from "@mail/workFlowEmail.services";
import ApiError from "@shared/utils/apiError";
import { uploadToS3, deleteReportImage } from "@shared/utils/aws-s3.services";
import { XlsxRow } from "@import-export/utils/xlsxWriter";
import { APP_KEY } from "./mediclaim.routes";
import legacyData from "./legacyBalances.json";

type Tx = Prisma.TransactionClient;

// ── constants ──────────────────────────────────────────────────────────────
const CLAIM_INITIATION_STATUS = "AWAITING_EX_EMPLOYEE";

const INITIATION_SEARCH_FIELDS = ["employeeName", "email", "mobile"] as const;
const CLAIM_SEARCH_FIELDS = [
	"employeeName",
	"ticketNumber",
	"referenceNumber",
] as const;

// ── eligibility rules ──────────────────────────────────────────────────────

/**
 * Which window "this year's" claims are counted over.
 *   false → calendar year (Jan–Dec) — how the backend has always counted.
 *   true  → financial year (Apr–Mar) — what the process document describes.
 * Mirrors MEDICLAIM_BACKEND.financialYearEligibility on the frontend: flip
 * BOTH together, otherwise the period label and the numbers disagree.
 */
export const FINANCIAL_YEAR_ELIGIBILITY = false;

/** Hospitalisation is tracked separately, under this existing claim head. */
export const HOSPITALISATION_CLAIM_HEAD = "EXCESS_HOSPITALISATION";

/** Hospitalisation cover for EG grades — ₹1.25 lakh per eligibility window. */
export const HOSPITALISATION_ANNUAL_CAP = 125_000;

/** Claims whose approved amounts count as already used. CLOSED = APPROVED + closed. */
const SETTLED_CLAIM_STATUSES = ["APPROVED", "CLOSED"] as const;

/**
 * Submitted but not yet settled. Their amounts are held back so a second
 * claim can't spend the same money. Released if the claim is rejected,
 * and moves to "settled" once approved.
 */
const HOLD_CLAIM_STATUSES = ["IN_PROGRESS", "CLARIFICATION_REQUESTED"] as const;

/** EG, EG-1A, EG-2B … — the only grades with hospitalisation cover. */
export const isHospitalisationGrade = (grade?: string | null): boolean =>
	/^EG/i.test((grade ?? "").trim());

export function getEligibilityWindowStart(ref: Date = new Date()): Date {
	if (!FINANCIAL_YEAR_ELIGIBILITY) return new Date(ref.getFullYear(), 0, 1);
	const startYear =
		ref.getMonth() >= 3 ? ref.getFullYear() : ref.getFullYear() - 1;
	return new Date(startYear, 3, 1);
}

const toNumber = (value: unknown): number => {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const formatInr = (value: number): string =>
	`₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface MedicalClaimBillInputRaw {
	id?: string;
	claimHead: string;
	billNo?: string;
	billName?: string;
	billDate?: string;
	amount: number;
	attachmentIndex?: number | null; // may be missing/null before validation
}

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

// ── sorting ──────────────────────────────────────────────────────────────

// Maps each whitelisted sortBy key (as sent by the frontend) to the actual
// Prisma field to order by. A whitelist — not raw pass-through — because an
// unrecognized key handed straight to Prisma's `orderBy` would throw at the
// DB layer; unknown keys fall back to the default safely. Mirrors
// resolveVendorListingOrderBy in vendorOnboarding.helper.ts.
const MEDICAL_CLAIM_SORT_FIELD_MAP: Record<string, string> = {
	employeeName: "employeeName",
	ticketNumber: "ticketNumber",
	referenceNumber: "referenceNumber",
	status: "status",
	created_at: "created_at",
	updated_at: "updated_at",
};

const DEFAULT_MEDICAL_CLAIM_SORT_FIELD = "created_at";
const DEFAULT_MEDICAL_CLAIM_SORT_ORDER = "desc";

// Resolves raw sortBy/sortOrder query values into a Prisma-safe `orderBy`
// object. Kept pure so it can be unit-tested without mocking Express/Prisma.
export const resolveMedicalClaimListingOrderBy = (
	sortBy: string | undefined,
	sortOrder: string | undefined,
): Record<string, "asc" | "desc"> => {
	const field =
		MEDICAL_CLAIM_SORT_FIELD_MAP[sortBy ?? ""] ??
		DEFAULT_MEDICAL_CLAIM_SORT_FIELD;

	const direction =
		sortOrder === "asc" || sortOrder === "desc"
			? sortOrder
			: DEFAULT_MEDICAL_CLAIM_SORT_ORDER;

	return { [field]: direction };
};

// ── export ───────────────────────────────────────────────────────────────

// Row shape for both the single-claim export (exportMedicalClaimById) and
// the bulk listing export (enqueueMedicalClaimExport) — one mapper, two
// callers, mirrors mapVendorOnboardingToXlsxRow.
export const mapMedicalClaimToXlsxRow = (claim: {
	referenceNumber: string;
	employeeName: string | null;
	ticketNumber: string | null;
	mobile: string | null;
	email: string | null;
	grade: string | null;
	location: string | null;
	patientName: string | null;
	claimCover: string | null;
	spouseName: string | null;
	medicalAdvanceTaken: unknown;
	eligibleAmount: unknown;
	alreadySettled: unknown;
	totalClaimed: unknown;
	status: string;
	submittedAt: Date | null;
	created_at: Date;
}): XlsxRow => ({
	"Reference Number": claim.referenceNumber,
	"Employee Name": claim.employeeName ?? "",
	"Ticket Number": claim.ticketNumber ?? "",
	Mobile: claim.mobile ?? "",
	Email: claim.email ?? "",
	Grade: claim.grade ?? "",
	Location: claim.location ?? "",
	"Patient Name": claim.patientName ?? "",
	"Claim Cover": claim.claimCover ?? "",
	"Spouse Name": claim.spouseName ?? "",
	"Medical Advance Taken": claim.medicalAdvanceTaken
		? Number(claim.medicalAdvanceTaken)
		: "",
	"Eligible Amount": claim.eligibleAmount ? Number(claim.eligibleAmount) : "",
	"Already Settled": claim.alreadySettled ? Number(claim.alreadySettled) : "",
	"Total Claimed": claim.totalClaimed ? Number(claim.totalClaimed) : "",
	Status: claim.status,
	"Submitted At": claim.submittedAt ?? "",
	"Created At": claim.created_at,
});

export const MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS: Record<string, number> = {
	"Reference Number": 26,
	"Employee Name": 24,
	Email: 28,
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

// ─────────────────────────────────────────────────────────────────────────────
// legacyMediclaimBalance.helper.ts
//
// One-time migration bridge for FY26-27 mediclaim history that predates this
// system — ~78 retirees whose manual claim records were never entered here.
// Loaded once into memory at process start; never written to, never re-read
// from disk. Consulted only as a fallback in computeMedicalClaimEligibility
// (zero real claims yet) and at initiation (to prefill grade/eligibility).
//
// Keyed by the retiree code (e.g. "RE10214") — exact match against
// MedicalClaim.ticketNumber, matching how staff enter it at initiation.
//
// TODO: remove this file and its one call site in mediclaim.helper.ts once
// every retiree in this dataset has submitted at least one claim through
// the system — at that point their real MedicalClaimBill history makes this
// permanently irrelevant for them, and eventually for everyone in the set.
// ─────────────────────────────────────────────────────────────────────────────

type LegacyMediclaimRecord = {
	name: string | null;
	grade: string | null;
	utilizedAmount: number;
};

const legacyBalanceMap = new Map<string, LegacyMediclaimRecord>(
	Object.entries(legacyData as Record<string, LegacyMediclaimRecord>),
);

export function getLegacyMediclaimRecord(
	ticketNumber: string | null | undefined,
): LegacyMediclaimRecord | null {
	if (!ticketNumber) return null;
	return legacyBalanceMap.get(ticketNumber.trim()) ?? null;
}

// ── claim history (settled vs held) ────────────────────────────────────────

type AmountBuckets = { standard: number; hospitalisation: number };

type ClaimHistory = { settled: AmountBuckets; held: AmountBuckets };

/**
 * What this retiree has already used, and what is currently held, inside the
 * eligibility window. Hospitalisation bills are bucketed separately so they
 * never eat into the regular annual limit (and vice versa).
 *
 *  settled — approvedClaimAmount of bills on APPROVED / CLOSED claims
 *  held    — bills on IN_PROGRESS / CLARIFICATION_REQUESTED claims: the
 *            approved amount if the bill is already approved, otherwise
 *            the claimed amount
 */
async function sumGuestClaimHistory(
	tx: Tx,
	guestId: string,
	excludeClaimId?: string,
): Promise<ClaimHistory> {
	const bills = await tx.medicalClaimBill.findMany({
		where: {
			claim: {
				guestId,
				status: { in: [...SETTLED_CLAIM_STATUSES, ...HOLD_CLAIM_STATUSES] },
				created_at: { gte: getEligibilityWindowStart() },
				...(excludeClaimId ? { id: { not: excludeClaimId } } : {}),
			},
		},
		select: {
			claimHead: true,
			amount: true,
			approved: true,
			approvedClaimAmount: true,
			claim: { select: { status: true } },
		},
	});

	const history: ClaimHistory = {
		settled: { standard: 0, hospitalisation: 0 },
		held: { standard: 0, hospitalisation: 0 },
	};

	for (const bill of bills) {
		const bucket =
			String(bill.claimHead) === HOSPITALISATION_CLAIM_HEAD
				? "hospitalisation"
				: "standard";
		const isSettled = (SETTLED_CLAIM_STATUSES as readonly string[]).includes(
			String(bill.claim.status),
		);

		if (isSettled) {
			history.settled[bucket] += toNumber(bill.approvedClaimAmount);
		} else {
			history.held[bucket] += bill.approved
				? toNumber(bill.approvedClaimAmount ?? bill.amount)
				: toNumber(bill.amount);
		}
	}

	return history;
}

// Server-side only — never trust a client-submitted eligible/settled amount.
// Shared between initiateMedicalClaim (no guestId yet), submitMedicalClaimForm,
// resubmitGuestMedicalClaim and the claim GET endpoints — one calculation, so
// it can't drift between them.
//
// guestId is optional: at initiation, no Guest exists yet, so there's no DB
// claim history to query — alreadySettled starts at 0 and falls straight
// through to the legacy lookup below.
//
// ticketNumber is optional: omit it once the legacy migration dataset is
// retired (see legacyMediclaimBalance.helper.ts).
//
// Return shape:
//   eligibleAmount / alreadySettled — unchanged meaning (annual cap minus
//     settled). These are what get stored on the claim, and the frontend
//     derives the annual cap from their sum, so they must NOT include holds.
//   inProgressAmount / availableAmount — the live hold: money tied up in the
//     retiree's other submitted-but-unsettled claims, and what is actually
//     left to claim after it.
//   hospitalisation — null unless the grade is EG; otherwise the separate
//     ₹1.25 lakh bucket with its own settled / held / available.
export async function computeMedicalClaimEligibility(
	tx: Tx,
	grade: string,
	options: {
		guestId?: string;
		ticketNumber?: string;
		excludeClaimId?: string;
	} = {},
) {
	const { guestId, ticketNumber, excludeClaimId } = options;

	const eligibility = await tx.gradeEligibility.findUnique({
		where: { grade },
	});
	if (!eligibility) return null;

	const history: ClaimHistory = guestId
		? await sumGuestClaimHistory(tx, guestId, excludeClaimId)
		: {
				settled: { standard: 0, hospitalisation: 0 },
				held: { standard: 0, hospitalisation: 0 },
			};

	let alreadySettled = history.settled.standard;

	// No real claim history yet (new Guest, or no Guest at all pre-initiation) —
	// fall back to the one-time FY26-27 migration snapshot for this retiree.
	// The legacy sheet is non-hospitalisation history, so it only feeds the
	// regular bucket.
	if (alreadySettled === 0 && ticketNumber) {
		const legacyRecord = getLegacyMediclaimRecord(ticketNumber);
		if (legacyRecord) alreadySettled = legacyRecord.utilizedAmount;
	}

	const annualCap = Number(eligibility.annualCap);
	const eligibleAmount = annualCap - alreadySettled;
	const inProgressAmount = round2(history.held.standard);
	const availableAmount = round2(
		Math.max(eligibleAmount - inProgressAmount, 0),
	);

	const hospitalisation = isHospitalisationGrade(grade)
		? {
				annualCap: HOSPITALISATION_ANNUAL_CAP,
				alreadySettled: round2(history.settled.hospitalisation),
				inProgressAmount: round2(history.held.hospitalisation),
				availableAmount: round2(
					Math.max(
						HOSPITALISATION_ANNUAL_CAP -
							history.settled.hospitalisation -
							history.held.hospitalisation,
						0,
					),
				),
			}
		: null;

	return {
		annualCap,
		eligibleAmount,
		alreadySettled,
		inProgressAmount,
		availableAmount,
		hospitalisation,
	};
}

export type MedicalClaimEligibility = NonNullable<
	Awaited<ReturnType<typeof computeMedicalClaimEligibility>>
>;

/**
 * Live eligibility for an existing claim, excluding the claim itself so its
 * own bills are never counted against it. Guests are keyed by mobile (same
 * identity key submit uses), so a claim that is still awaiting its first
 * submission — no guestId yet — still sees the retiree's earlier claims.
 * Returns null when the claim has no grade yet.
 */
export async function getLiveEligibilityForClaim(
	tx: Tx,
	claim: {
		id: string;
		guestId: string | null;
		mobile: string | null;
		grade: string | null;
		ticketNumber: string | null;
	},
): Promise<MedicalClaimEligibility | null> {
	if (!claim.grade) return null;

	let guestId = claim.guestId ?? undefined;
	if (!guestId && claim.mobile) {
		const guest = await tx.guest.findUnique({
			where: { mobile: claim.mobile },
			select: { id: true },
		});
		guestId = guest?.id;
	}

	return computeMedicalClaimEligibility(tx, claim.grade, {
		guestId,
		ticketNumber: claim.ticketNumber ?? undefined,
		excludeClaimId: claim.id,
	});
}

/**
 * Submit / resubmit guard — the server-side half of the in-progress hold and
 * the EG-only hospitalisation rule. The frontend enforces the same limits for
 * a good error message, but a client can't be trusted to.
 *
 *  - hospitalisation bills need an EG grade
 *  - regular bills must fit in what's available after holds
 *  - hospitalisation bills must fit in the hospitalisation bucket
 *
 * Known limit: two submits from the same retiree at the same instant can
 * both pass this check; closing that needs a row lock or Serializable
 * isolation around the submit transaction.
 */
export function assertBillsWithinEligibility(
	bills: MedicalClaimBillInputRaw[],
	grade: string,
	eligibility: MedicalClaimEligibility,
): void {
	const totals = bills.reduce(
		(sum, bill) => {
			const bucket =
				String(bill.claimHead) === HOSPITALISATION_CLAIM_HEAD
					? "hospitalisation"
					: "standard";
			sum[bucket] += toNumber(bill.amount);
			return sum;
		},
		{ standard: 0, hospitalisation: 0 },
	);

	if (totals.hospitalisation > 0 && !eligibility.hospitalisation) {
		throw new ApiError(
			400,
			`Hospitalisation expenses are covered only for EG grades (grade "${grade}" is not eligible)`,
		);
	}

	if (totals.standard > eligibility.availableAmount + 0.001) {
		const hold =
			eligibility.inProgressAmount > 0
				? ` ${formatInr(eligibility.inProgressAmount)} of the limit is on hold for claims that are still in progress.`
				: "";
		throw new ApiError(
			400,
			`Claimed total ${formatInr(totals.standard)} exceeds the ${formatInr(eligibility.availableAmount)} available.${hold}`,
		);
	}

	if (
		eligibility.hospitalisation &&
		totals.hospitalisation > eligibility.hospitalisation.availableAmount + 0.001
	) {
		const { availableAmount, inProgressAmount } = eligibility.hospitalisation;
		const hold =
			inProgressAmount > 0
				? ` ${formatInr(inProgressAmount)} is on hold for hospitalisation claims that are still in progress.`
				: "";
		throw new ApiError(
			400,
			`Hospitalisation total ${formatInr(totals.hospitalisation)} exceeds the ${formatInr(availableAmount)} available.${hold}`,
		);
	}
}

// Resolves grade for a retiree at claim-initiation time, before any form
// submission exists. User.grade (live HR master) takes priority since it
// reflects the current record; the legacy migration snapshot is only a
// fallback for someone no longer present as a User.
export async function resolveGradeForTicketNumber(
	tx: Tx,
	ticketNumber: string,
): Promise<string | null> {
	const user = await tx.user.findFirst({
		where: { employeeCode: ticketNumber },
		select: { grade: true },
	});
	if (user?.grade) return user.grade;

	const legacyRecord = getLegacyMediclaimRecord(ticketNumber);
	return legacyRecord?.grade ?? null;
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
			initiatedById: true,
		},
	});
	if (!claim?.guestId) return;

	const latestClarification = await prisma.activityLog.findFirst({
		where: {
			subjectType: APP_KEY,
			subjectId: claimId,
			action: "CLARIFY",
		},
		orderBy: { createdAt: "desc" },
		select: { metadata: true, createdAt: true },
	});

	await sendWorkflowMail(
		{
			to: claim.email as string,
			subject: "Medical Claim — Clarification Requested",
			templateName: "medical-claim-clarification",
			templateData: {
				employeeName: claim.employeeName,
				claimReference: claim.referenceNumber,
				clarificationReason:
					(latestClarification?.metadata as { reason?: string } | null)
						?.reason ?? null,
				formUrl: `${process.env.FRONTEND_URL}/guest/login`,
			},
		},
		claim.initiatedById,
	);
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

// Shared bill upsert for draft/submit/resubmit. Bills are matched by id —
// present + belonging to this claim ⇒ update in place (preserving the
// existing S3 attachment if no new file is sent this round); otherwise
// created fresh. Bills removed from the payload (present in DB, absent
// here) are deleted along with their S3 object. requireAttachment governs
// whether a bill needs SOME attachment (new file or a pre-existing one) —
// false for drafts (partial saves are expected), true for submit/resubmit.
export const upsertMedicalClaimBills = async (
	tx: Tx,
	claimId: string,
	bills: MedicalClaimBillInputRaw[],
	files: Express.Multer.File[],
	options: { requireAttachment: boolean },
): Promise<number> => {
	const existingBills = await tx.medicalClaimBill.findMany({
		where: { claimId },
		select: { id: true, s3Key: true },
	});
	const existingIds = new Set(existingBills.map((b) => b.id));
	const s3KeyById = new Map(existingBills.map((b) => [b.id, b.s3Key]));
	const keptIds = new Set<string>();

	if (options.requireAttachment) {
		bills.forEach((bill, index) => {
			const isExisting = Boolean(bill.id && existingIds.has(bill.id));
			const previousS3Key = isExisting
				? (s3KeyById.get(bill.id!) ?? null)
				: null;
			const hasNewFile =
				bill.attachmentIndex != null && Boolean(files[bill.attachmentIndex]);

			if (!hasNewFile && !previousS3Key) {
				throw new ApiError(
					400,
					`An attachment is required for bill #${index + 1} (${bill.claimHead})`,
				);
			}
		});
	}

	for (const [index, bill] of bills.entries()) {
		const isExisting = Boolean(bill.id && existingIds.has(bill.id));
		const previousS3Key = isExisting ? (s3KeyById.get(bill.id!) ?? null) : null;
		const file =
			bill.attachmentIndex != null ? files[bill.attachmentIndex] : undefined;

		let s3Key: string | null = previousS3Key;
		if (file) {
			const extension = getBillAttachmentExtension(file.mimetype);
			s3Key = `medical-claim-bills/${claimId}/${index}-${bill.claimHead}.${extension}`;
			await uploadToS3(s3Key, file.buffer, file.mimetype);

			if (previousS3Key && previousS3Key !== s3Key) {
				await deleteReportImage(previousS3Key);
			}
		}

		const data = {
			claimId,
			claimHead: bill.claimHead as any,
			billNo: bill.billNo,
			billName: bill.billName,
			billDate: bill.billDate ? new Date(bill.billDate) : null,
			amount: bill.amount,
			s3Key,
		};

		if (isExisting) {
			await tx.medicalClaimBill.update({ where: { id: bill.id }, data });
			keptIds.add(bill.id!);
		} else {
			const created = await tx.medicalClaimBill.create({ data });
			keptIds.add(created.id);
		}
	}

	const toDelete = existingBills.filter((b) => !keptIds.has(b.id));
	if (toDelete.length) {
		await tx.medicalClaimBill.deleteMany({
			where: { id: { in: toDelete.map((b) => b.id) } },
		});
		await Promise.all(
			toDelete
				.filter((b) => b.s3Key)
				.map((b) => deleteReportImage(b.s3Key as string)),
		);
	}

	return bills.reduce((sum, b) => sum + Number(b.amount), 0);
};

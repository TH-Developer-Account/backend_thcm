import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "@shared/config/prisma";
import { sendWorkflowMail } from "@mail/workFlowEmail.services";
import ApiError from "@shared/utils/apiError";
import { uploadToS3, deleteReportImage } from "@shared/utils/aws-s3.services";
import { XlsxRow } from "@import-export/utils/xlsxWriter";
import { APP_KEY } from "./mediclaim.routes";
import {
	CLAIM_HEADS,
	HOLD_CLAIM_STATUSES,
	SETTLED_CLAIM_STATUSES,
	buildEligibility,
	emptyHistory,
	evaluateBillsAgainstEligibility,
	getEligibilityWindow,
	getLegacyMediclaimRecord,
	getLegacyPaise,
	normalizeGrade,
	normalizeTicketNumber,
	round2,
	sumBillsIntoHistory,
	toPaise,
	type ClaimHistoryPaise,
	type EligibilityWindow,
	type MedicalClaimEligibility,
} from "./mediclaim.eligibility";

// The pure rules live in mediclaim.eligibility.ts (unit-tested without a DB).
// Re-exported so existing imports from "./mediclaim.helper" keep working.
export {
	FINANCIAL_YEAR_ELIGIBILITY,
	HOSPITALISATION_ANNUAL_CAP,
	HOSPITALISATION_CLAIM_HEAD,
	SETTLED_CLAIM_STATUSES,
	approvedPaise,
	getEligibilityWindow,
	getEligibilityWindowStart,
	getLegacyMediclaimRecord,
	isHospitalisationGrade,
	isHospitalisationHead,
	normalizeGrade,
	toPaise,
	type MedicalClaimEligibility,
} from "./mediclaim.eligibility";

type Tx = Prisma.TransactionClient;

// ── constants ──────────────────────────────────────────────────────────────
const CLAIM_INITIATION_STATUS = "AWAITING_EX_EMPLOYEE";

const INITIATION_SEARCH_FIELDS = ["employeeName", "email", "mobile"] as const;
const CLAIM_SEARCH_FIELDS = [
	"employeeName",
	"ticketNumber",
	"referenceNumber",
] as const;

// Decimal(12,2) tops out near ₹10 billion; the form allows 9 digits.
const MAX_BILL_AMOUNT = 999_999_999;

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

// An amount of 0 is a real value (e.g. nothing settled yet); only a missing
// value exports as blank. The old `x ? Number(x) : ""` hid every zero.
const amountOrBlank = (value: unknown): number | "" =>
	value === null || value === undefined || value === "" ? "" : Number(value);

// Row shape for both the single-claim export (exportMedicalClaimById) and
// the bulk listing export (enqueueMedicalClaimExport) — one mapper, two
// callers, mirrors mapVendorOnboardingToXlsxRow.
//
// "Eligible Amount" / "Already Settled" are the NON-hospitalisation figures;
// the two Hospitalisation columns are filled for EG grades only.
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
	hospitalisationEligibleAmount?: unknown;
	hospitalisationAlreadySettled?: unknown;
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
	"Medical Advance Taken": amountOrBlank(claim.medicalAdvanceTaken),
	"Eligible Amount": amountOrBlank(claim.eligibleAmount),
	"Already Settled": amountOrBlank(claim.alreadySettled),
	"Hospitalisation Eligible Amount": amountOrBlank(
		claim.hospitalisationEligibleAmount,
	),
	"Hospitalisation Already Settled": amountOrBlank(
		claim.hospitalisationAlreadySettled,
	),
	"Total Claimed": amountOrBlank(claim.totalClaimed),
	Status: claim.status,
	"Submitted At": claim.submittedAt ?? "",
	"Created At": claim.created_at,
});

export const MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS: Record<string, number> = {
	"Reference Number": 26,
	"Employee Name": 24,
	Email: 28,
	"Hospitalisation Eligible Amount": 30,
	"Hospitalisation Already Settled": 30,
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

// ── bill input validation ──────────────────────────────────────────────────

/**
 * `bills` arrives as a JSON string on multipart requests. A malformed payload
 * is a 400, not a 500.
 */
export function parseBillsPayload(raw: unknown): unknown[] {
	if (raw === undefined || raw === null || raw === "") return [];
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ApiError(400, "Bills must be valid JSON");
		}
	}
	if (!Array.isArray(parsed)) throw new ApiError(400, "Bills must be an array");
	return parsed;
}

/**
 * Validates every bill and normalises its amount to 2 decimals.
 *   submit / resubmit → allowZero: false (every bill must claim something)
 *   draft             → allowZero: true  (partially filled rows are expected)
 * A negative amount would silently offset the other bills in the limit check,
 * and NaN would slip through every comparison, so both are rejected here.
 */
export function normalizeBillInputs(
	bills: unknown[],
	options: { allowZero: boolean },
): MedicalClaimBillInputRaw[] {
	return bills.map((raw, index) => {
		const bill = (raw ?? {}) as Record<string, unknown>;
		const label = `Bill #${index + 1}`;

		const claimHead = String(bill.claimHead ?? "");
		if (!(CLAIM_HEADS as readonly string[]).includes(claimHead)) {
			throw new ApiError(400, `${label}: invalid claim head "${claimHead}"`);
		}

		const amount = round2(Number(bill.amount));
		if (!Number.isFinite(amount)) {
			throw new ApiError(400, `${label}: amount must be a number`);
		}
		if (options.allowZero ? amount < 0 : amount <= 0) {
			throw new ApiError(
				400,
				`${label}: amount must be greater than zero`,
			);
		}
		if (amount > MAX_BILL_AMOUNT) {
			throw new ApiError(400, `${label}: amount is too large`);
		}

		return { ...bill, claimHead, amount } as MedicalClaimBillInputRaw;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY — DB layer
//
// The rules themselves (caps, buckets, legacy, rounding) are in
// mediclaim.eligibility.ts. This section only fetches what they need.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GradeEligibility lookup that tolerates stray whitespace / casing on either
 * side ("EG-4  " from HR data vs "EG-4" in the table). The table has ~15 rows,
 * so matching in memory is cheaper than being clever in SQL.
 */
async function findGradeRow(tx: Tx, grade: string) {
	const target = normalizeGrade(grade);
	if (!target) return null;
	const rows = await tx.gradeEligibility.findMany();
	return rows.find((row) => normalizeGrade(row.grade) === target) ?? null;
}

/**
 * What this retiree has already used / has on hold inside the window.
 *
 * Matched by guestId OR ticketNumber: the ticket number (retiree code) is the
 * real identity, so a retiree who submits again from a different mobile — and
 * therefore gets a new Guest — still sees their earlier claims.
 *
 * The window is on submittedAt (when the money was claimed), falling back to
 * created_at for any claim that has none. Bucketing by created_at would put a
 * claim initiated on 28 Mar and submitted on 3 Apr into the wrong year.
 */
async function sumRetireeClaimHistory(
	tx: Tx,
	identity: { guestId?: string; ticketNumber?: string },
	window: EligibilityWindow,
	excludeClaimId?: string,
): Promise<ClaimHistoryPaise> {
	const who: Prisma.MedicalClaimWhereInput[] = [];
	if (identity.guestId) who.push({ guestId: identity.guestId });
	if (identity.ticketNumber?.trim()) {
		who.push({
			ticketNumber: { equals: identity.ticketNumber.trim(), mode: "insensitive" },
		});
	}
	if (who.length === 0) return emptyHistory();

	const bills = await tx.medicalClaimBill.findMany({
		where: {
			claim: {
				AND: [
					{ OR: who },
					{
						OR: [
							{ submittedAt: { gte: window.start, lt: window.end } },
							{
								submittedAt: null,
								created_at: { gte: window.start, lt: window.end },
							},
						],
					},
				],
				status: { in: [...SETTLED_CLAIM_STATUSES, ...HOLD_CLAIM_STATUSES] },
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

	return sumBillsIntoHistory(
		bills.map((bill) => ({
			claimHead: bill.claimHead,
			amount: bill.amount,
			approved: bill.approved,
			approvedClaimAmount: bill.approvedClaimAmount,
			claimStatus: bill.claim.status,
		})),
	);
}

// Server-side only — never trust a client-submitted eligible/settled amount.
// Shared between initiateMedicalClaim, the bulk import, submitMedicalClaimForm,
// resubmitGuestMedicalClaim, the approver's approved-amounts step and the
// claim GET endpoints — ONE calculation, so it can't drift between them.
//
// guestId / ticketNumber are both optional; whichever are given identify the
// retiree's history (see sumRetireeClaimHistory). The legacy FY26-27 balance is
// keyed by ticketNumber and is ALWAYS added to the real settled amount.
//
// Return shape (see BucketEligibility in mediclaim.eligibility.ts):
//   annualCap / eligibleAmount / alreadySettled / inProgressAmount /
//   availableAmount — the NON-hospitalisation bucket. These are what get
//   stored on the claim; eligibleAmount does NOT subtract holds.
//   hospitalisation — null unless the grade is EG; then the separate
//   ₹1.25 lakh bucket with the same five figures.
//   totalAnnualCap / period — for display.
export async function computeMedicalClaimEligibility(
	tx: Tx,
	grade: string,
	options: {
		guestId?: string;
		ticketNumber?: string;
		excludeClaimId?: string;
	} = {},
): Promise<MedicalClaimEligibility | null> {
	const { guestId, ticketNumber, excludeClaimId } = options;

	const gradeRow = await findGradeRow(tx, grade);
	// No row at all (grade truly unknown) OR a row whose annualCap hasn't been
	// set yet (see updateUserHrData.ts, which inserts grades discovered from
	// HR data with annualCap: null pending manual entry) — both mean "can't
	// compute a cap", and must return null, not fall through to
	// Number(null) === 0, which would silently produce eligibleAmount = 0
	// instead of "not eligible yet".
	if (!gradeRow || gradeRow.annualCap === null) return null;

	const window = getEligibilityWindow();
	const history = await sumRetireeClaimHistory(
		tx,
		{ guestId, ticketNumber },
		window,
		excludeClaimId,
	);

	return buildEligibility({
		grade: normalizeGrade(grade),
		standardCap: Number(gradeRow.annualCap),
		history,
		legacy: getLegacyPaise(ticketNumber, window),
		window,
	});
}

/** The four eligibility columns stored on MedicalClaim (snapshot at submit). */
export const eligibilityToClaimColumns = (
	eligibility: MedicalClaimEligibility,
) => ({
	eligibleAmount: eligibility.eligibleAmount,
	alreadySettled: eligibility.alreadySettled,
	hospitalisationEligibleAmount: eligibility.hospitalisation?.eligibleAmount ?? null,
	hospitalisationAlreadySettled: eligibility.hospitalisation?.alreadySettled ?? null,
});

/**
 * Serialises concurrent submits for the same retiree. Without it, two claims
 * submitted at the same instant both read the same "available" figure and both
 * pass the limit check. pg_advisory_xact_lock is held until the surrounding
 * transaction ends. Always lock in this order (ticket, then guest) so two
 * handlers can never deadlock each other.
 */
export async function lockRetireeLedger(
	tx: Tx,
	identity: { ticketNumber?: string | null; guestId?: string | null },
): Promise<void> {
	const keys: string[] = [];
	const ticket = normalizeTicketNumber(identity.ticketNumber);
	if (ticket) keys.push(`medclaim:ticket:${ticket}`);
	if (identity.guestId) keys.push(`medclaim:guest:${identity.guestId}`);

	for (const key of keys) {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
	}
}

// Resolves grade for a retiree from the ticket number. User.grade (live HR
// master) takes priority since it reflects the current record; the legacy
// migration snapshot is only a fallback for someone no longer present as a
// User. Returned normalised ("EG-4  " → "EG-4").
export async function resolveGradeForTicketNumber(
	tx: Tx,
	ticketNumber: string,
): Promise<string | null> {
	const ticket = ticketNumber.trim();
	if (!ticket) return null;

	const user = await tx.user.findFirst({
		where: { employeeCode: { equals: ticket, mode: "insensitive" } },
		select: { grade: true },
	});
	const fromUser = normalizeGrade(user?.grade);
	if (fromUser) return fromUser;

	const fromLegacy = normalizeGrade(getLegacyMediclaimRecord(ticket)?.grade);
	return fromLegacy || null;
}

/**
 * The grade that decides the cap. The grade is NOT taken on trust from the
 * request body: it drives the money, so in order of authority:
 *   1. the grade HR holds for the claim's ticket number (server-side)
 *   2. the grade the form sent (only when there is no ticket to look up)
 *   3. the grade already stored on the claim
 * Returns null only when `required` is false and nothing is known.
 */
export async function resolveEffectiveGrade(
	tx: Tx,
	claim: { grade: string | null; ticketNumber: string | null },
	clientGrade?: unknown,
	options: { required: boolean } = { required: true },
): Promise<string | null> {
	if (claim.ticketNumber) {
		const authoritative = await resolveGradeForTicketNumber(
			tx,
			claim.ticketNumber,
		);
		if (authoritative) return authoritative;
	}

	const supplied =
		typeof clientGrade === "string" ? normalizeGrade(clientGrade) : "";
	if (supplied) return supplied;

	const stored = normalizeGrade(claim.grade);
	if (stored) return stored;

	if (options.required) {
		throw new ApiError(400, "Grade is required to compute eligibility");
	}
	return null;
}

/**
 * Initiation-time prefill — ONE function used by both the single initiate
 * endpoint and the bulk import, so the two can never disagree. Resolves the
 * retiree's grade from the ticket number, then stores grade + the eligibility
 * snapshot on the claim. Returns the updated claim, or null when there is
 * nothing to prefill (no ticket, unknown grade, or no cap configured).
 */
export async function prefillClaimEligibility(
	tx: Tx,
	claim: { id: string; ticketNumber: string | null; mobile: string | null },
) {
	if (!claim.ticketNumber) return null;

	const grade = await resolveGradeForTicketNumber(tx, claim.ticketNumber);
	if (!grade) return null;

	// A returning retiree already has a Guest (keyed by mobile), so their
	// earlier claims — settled and in progress — count at initiation too.
	const existingGuest = claim.mobile
		? await tx.guest.findUnique({
				where: { mobile: claim.mobile },
				select: { id: true },
			})
		: null;

	const eligibility = await computeMedicalClaimEligibility(tx, grade, {
		guestId: existingGuest?.id,
		ticketNumber: claim.ticketNumber,
		excludeClaimId: claim.id,
	});
	if (!eligibility) return null;

	return tx.medicalClaim.update({
		where: { id: claim.id },
		data: { grade, ...eligibilityToClaimColumns(eligibility) },
	});
}

/**
 * Live eligibility for an existing claim, excluding the claim itself so its
 * own bills are never counted against it. Guests are keyed by mobile (same
 * identity key submit uses), so a claim that is still awaiting its first
 * submission — no guestId yet — still sees the retiree's earlier claims.
 * Returns null when the claim's grade can't be determined or has no cap.
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
	const grade = await resolveEffectiveGrade(tx, claim, null, {
		required: false,
	});
	if (!grade) return null;

	let guestId = claim.guestId ?? undefined;
	if (!guestId && claim.mobile) {
		const guest = await tx.guest.findUnique({
			where: { mobile: claim.mobile },
			select: { id: true },
		});
		guestId = guest?.id;
	}

	return computeMedicalClaimEligibility(tx, grade, {
		guestId,
		ticketNumber: claim.ticketNumber ?? undefined,
		excludeClaimId: claim.id,
	});
}

/**
 * Submit / resubmit guard — the server-side half of the in-progress hold and
 * the EG-only hospitalisation rule. The frontend enforces the same limits for
 * a good error message, but a client can't be trusted to. Call it AFTER
 * lockRetireeLedger inside the same transaction, so two simultaneous submits
 * for one retiree are checked one after the other.
 */
export function assertBillsWithinEligibility(
	bills: MedicalClaimBillInputRaw[],
	grade: string,
	eligibility: MedicalClaimEligibility,
): void {
	const problem = evaluateBillsAgainstEligibility(bills, grade, eligibility);
	if (problem) throw new ApiError(400, problem);
}

/**
 * Approver rule: approving a line without typing an amount means the claimed
 * amount IS the approved amount. Fills every bill that still has no approved
 * amount with its claimed amount and marks it approved. Safe to call more than
 * once. (Sums already treat a null approvedClaimAmount on a settled claim as
 * the claimed amount, so this is about making the stored data match, for the
 * PDF and the export.)
 */
export async function finalizeMedicalClaimBillAmounts(
	tx: Tx,
	claimId: string,
): Promise<number> {
	const pending = await tx.medicalClaimBill.findMany({
		where: { claimId, approvedClaimAmount: null },
		select: { id: true, amount: true },
	});
	for (const bill of pending) {
		await tx.medicalClaimBill.update({
			where: { id: bill.id },
			data: { approved: true, approvedClaimAmount: bill.amount },
		});
	}
	return pending.length;
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
//
// If the ex-employee CHANGES a bill's amount (e.g. after a clarification), any
// earlier approval on that line is cleared — an approved amount from the old
// figure must not carry over to the new one. Returns the total claimed.
export const upsertMedicalClaimBills = async (
	tx: Tx,
	claimId: string,
	bills: MedicalClaimBillInputRaw[],
	files: Express.Multer.File[],
	options: { requireAttachment: boolean },
): Promise<number> => {
	const existingBills = await tx.medicalClaimBill.findMany({
		where: { claimId },
		select: { id: true, s3Key: true, amount: true },
	});
	const existingIds = new Set(existingBills.map((b) => b.id));
	const s3KeyById = new Map(existingBills.map((b) => [b.id, b.s3Key]));
	const amountPaiseById = new Map(
		existingBills.map((b) => [b.id, toPaise(b.amount)]),
	);
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
			const amountChanged =
				amountPaiseById.get(bill.id!) !== toPaise(bill.amount);
			await tx.medicalClaimBill.update({
				where: { id: bill.id },
				data: amountChanged
					? { ...data, approved: false, approvedClaimAmount: null }
					: data,
			});
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

	// Paise sum → rupees once, so 17,754.42 + 1,338.50 never drifts.
	return bills.reduce((sum, b) => sum + toPaise(b.amount), 0) / 100;
};

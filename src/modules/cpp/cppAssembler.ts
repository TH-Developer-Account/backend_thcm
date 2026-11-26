import { createHash } from "crypto";
import path from "path";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";
import logger from "@shared/utils/logger";

import {
	CPP_MAX_PARSE_BYTES,
	CPP_SUBJECT_TYPE,
	plantCodeOf,
} from "./cpp.constants";
import { asObject, sectionDataOf } from "./cpp.helper";
import {
	EMPTY_PART_ROWS,
	parseCppPartRows,
	summariseImpact,
	type CppPartRows,
	type CppSummaryRow,
} from "./cpp.sheet";

// ─────────────────────────────────────────────────────────────────────────────
// CPP — PDF DATA ASSEMBLER
//
// Fetches the request, who initiated it, its workflow, its audit trail and the
// uploaded files, and shapes them for cppDocDefinition.ts. Knows nothing about
// pdfmake. The approval workflow is NOT re-derived here: the people on the form
// are the approvers the engine really assigned to the request.
//
// Every value the on-screen sheet (CppPdfView.tsx) shows comes from the same
// saved section here, so the view and the export print the same numbers.
// ─────────────────────────────────────────────────────────────────────────────

const MERGEABLE_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
/** "For more than 5 parts, please use summary sheet" (CPP format), same as the view. */
export const MAX_FORM_PARTS = 5;

export interface CppSigner {
	name: string;
	designation: string | null;
	/** PENDING | APPROVED | REJECTED | CLARIFIED … (raw approval status). */
	status: string;
	actedAt: Date | null;
}

export interface CppPdfSupplier {
	name: string;
	code: string;
}

/** One part line on page 1 (the first five summary-sheet rows). */
export interface CppFormPart {
	partNo: string;
	description: string;
	uom: string;
	existingPrice: number | null;
	newPrice: number | null;
	effectiveDate: string;
	/** Fraction (0.05 = 5 %), as read from the summary sheet. */
	pctChange: number | null;
}

/** Financial Impact row. Percentages are in percent units (5 = 5 %). */
export interface FinancialRow {
	actual: number | null;
	actualPct: number | null;
	annual: number | null;
	annualPct: number | null;
}

export type TextRow = Record<string, string>;

export interface CppWorkflowRow {
	phase: "WF1" | "WF2";
	stageOrder: number;
	stageName: string;
	stageStatus: string;
	approver: string;
	designation: string;
	email: string;
	status: string;
	actedAt: Date | null;
}

export interface CppAuditRow {
	at: Date;
	action: string;
	by: string;
	stage: string;
	remarks: string;
}

export interface CppPdfData {
	referenceNumber: string;
	status: string;
	/** Printed next to "Approval Ref." (initiation date, as on the view). */
	date: Date | null;
	category: string;
	plant: string;
	condition: string;
	isSpare: boolean;

	reason: string;
	effects: string[];
	materialType: string;
	priceType: string; // STANDARD | SUBCONTRACTING | ""
	pricingCondition: string; // PB00 | PB25 | PB50 | PB75 | ""
	justification: string;
	models: string[];
	applicablePlants: string[];
	/** SAP codes of the applicable plant / warehouse rows (Master data tab). */
	applicableCodes: string[];

	suppliers: {
		existing: CppPdfSupplier;
		other: CppPdfSupplier;
		recommended: CppPdfSupplier;
	};
	/** "For Plants" box (DWD / KGP rows of the Master data tab). */
	master: {
		incoTerms: string;
		purchasingGroup: string;
		taxCode: string;
		storeLocation: string;
	};
	/** "For Spares" box (warehouse rows of the Master data tab). */
	spares: {
		incoTerms: string;
		pfPct: string;
		taxCode: string;
	};

	/** Part lines of the purchasing table (max 5) and how many the sheet has. */
	formParts: CppFormPart[];
	partCount: number;

	impact: {
		actual: number | null;
		annual: number | null;
		actualPct: number | null; // fraction
		annualPct: number | null;
	};
	/** Financial Impact box: what the proposer typed, else summed from the summary sheet. */
	financial: Record<ImpactRow, FinancialRow>;
	financialTotal: FinancialRow;

	amortisation: TextRow[];
	perMachine: TextRow[];
	volumes: Record<
		ImpactRow,
		{ received: string; remaining: string; annual: string }
	>;
	plantPrices: TextRow[];
	costTracker: TextRow[];

	/** Same rule as the view: the title of the last approval stage. */
	approvingAuthority: string;

	proposer: CppSigner | null;
	checkedBy: CppSigner[];
	recommendedBy: CppSigner[];
	approvedBy: CppSigner[];
	committee: CppSigner[];
	altChairman: CppSigner[];
	chairman: CppSigner[];
	managingDirector: CppSigner[];
	/** Dates for the "Approval dates and references" strip. */
	cppDate: Date | null;
	mdDate: Date | null;

	/** Mandatory Check List: the Yes / No / NA the proposer saved. */
	checklist: Array<{ label: string; value: string }>;

	/** Appendix page: every stage and approver of the current iteration. */
	workflowRows: CppWorkflowRow[];
	/** Appendix page: every logged action, oldest first. */
	auditTrail: CppAuditRow[];

	parts: CppPartRows;
	/** Name of the file the parts came from (for the footer). */
	partsFileName: string | null;

	/** Uploaded PDFs / images appended after the generated pages. */
	attachments: Array<{
		type: string;
		fileName: string;
		s3Key: string;
		uploadedAt: Date;
	}>;
	updatedAt: Date;
	/** Fingerprint of every upload (incl. the purchasing Excel) for the cache key. */
	uploadsFingerprint: string;
	generatedAt: Date;
}

/* --------------------------------- helpers -------------------------------- */

const str = (v: unknown): string =>
	v === null || v === undefined ? "" : String(v).trim();

const strList = (v: unknown): string[] =>
	Array.isArray(v) ? v.map(str).filter(Boolean) : [];

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const supplierOf = (v: unknown): CppPdfSupplier => {
	const s = asObject(v);
	return { name: str(s.name), code: str(s.code) };
};

const numOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const textOf = (value: unknown): string =>
	value === null || value === undefined ? "" : String(value);

/** "2026-11-26" -> Date at local midnight; null when blank or invalid. */
const isoDate = (value: unknown): Date | null => {
	const s = str(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
	const [y, m, d] = s.split("-").map(Number);
	const date = new Date(y, m - 1, d);
	return Number.isNaN(date.getTime()) ? null : date;
};

/** Table rows saved in a section, as plain strings; blank rows dropped. */
const textRows = (value: unknown, keys: string[]): TextRow[] =>
	(Array.isArray(value) ? value : [])
		.map((row) => {
			const r = asObject(row);
			return Object.fromEntries(keys.map((k) => [k, str(r[k])]));
		})
		.filter((row) => Object.values(row).some(Boolean));

/** Parsed summary-sheet rows (cpp.partSummary.ts) -> the part lines the PDF reads. */
function summaryRowsOf(parsed: unknown): CppSummaryRow[] {
	const rows = asObject(parsed).rows;
	if (!Array.isArray(rows)) return [];
	return rows.map((r) => {
		const row = asObject(r);
		return {
			kind: "part" as const,
			slNo: numOrNull(row.slNo),
			plant: textOf(row.plant),
			model: textOf(row.model),
			partNo: textOf(row.partNo),
			description: textOf(row.description),
			uom: textOf(row.uom),
			existingPrice: numOrNull(row.existingPrice),
			newPrice: numOrNull(row.newPrice),
			difference: numOrNull(row.difference),
			currentPo: textOf(row.currentPo),
			effectiveDate: textOf(row.effectiveDate),
			rcvdQty: numOrNull(row.rcvdQty),
			actualImpact: numOrNull(row.actualImpact),
			abpVol: numOrNull(row.abpVol),
			qtyPerMc: numOrNull(row.qtyPerMc),
			annualisedImpact: numOrNull(row.annualisedImpact),
			pctChange: numOrNull(row.pctChange),
		};
	});
}

/* Mandatory Check List: the answer the proposer saved (other.checklist). */
const CHECKLIST: Array<{ label: string; key: string }> = [
	{ label: "1) Annualized Impact Cal.", key: "annualisedImpact" },
	{ label: "2) Model wise Impact Cal.", key: "modelImpact" },
	{ label: "3) ZBC Calculation", key: "zbc" },
	{ label: "4) Commodity Price Trend", key: "commodityTrend" },
	{ label: "5) ECN attached", key: "ecn" },
	{ label: "6) Nesting Calculation", key: "nesting" },
	{ label: "7) Comparative Quote./Ana.", key: "comparativeQuote" },
];

/* ---- Financial Impact rows: the form shows KGP, DWD and SPARE ---- */
export type ImpactRow = "KGP" | "DWD" | "SPARE";
const IMPACT_ROWS: ImpactRow[] = ["KGP", "DWD", "SPARE"];
export interface PlantImpact {
	actual: number | null;
	annual: number | null;
	actualPct: number | null;
	annualPct: number | null;
}

/** Summary-sheet plant -> form row. 3006 = KGP, 1006 = DWD, every other plant is spares. */
const impactRowOf = (plant: string): ImpactRow | null => {
	const code = plantCodeOf(plant);
	if (!code) return null;
	if (code === "3006") return "KGP";
	if (code === "1006") return "DWD";
	return "SPARE";
};

/** Summary-sheet rows summed per form row. Percentages are fractions here. */
function impactByPlantOf(
	rows: CppSummaryRow[],
): Record<ImpactRow, PlantImpact> {
	const acc: Record<
		ImpactRow,
		{
			actual: number | null;
			annual: number | null;
			actualBase: number;
			annualBase: number;
		}
	> = {
		KGP: { actual: null, annual: null, actualBase: 0, annualBase: 0 },
		DWD: { actual: null, annual: null, actualBase: 0, annualBase: 0 },
		SPARE: { actual: null, annual: null, actualBase: 0, annualBase: 0 },
	};
	for (const r of rows) {
		const key = impactRowOf(r.plant);
		if (!key) continue;
		const slot = acc[key];
		if (r.actualImpact !== null)
			slot.actual = (slot.actual ?? 0) + r.actualImpact;
		if (r.annualisedImpact !== null)
			slot.annual = (slot.annual ?? 0) + r.annualisedImpact;
		if (r.existingPrice !== null) {
			slot.actualBase += r.existingPrice * (r.rcvdQty ?? 0);
			slot.annualBase += r.existingPrice * (r.abpVol ?? 0) * (r.qtyPerMc ?? 0);
		}
	}
	const pct = (value: number | null, base: number) =>
		value !== null && base ? value / base : null;
	const out = {} as Record<ImpactRow, PlantImpact>;
	IMPACT_ROWS.forEach((k) => {
		const s = acc[k];
		out[k] = {
			actual: s.actual,
			annual: s.annual,
			actualPct: pct(s.actual, s.actualBase),
			annualPct: pct(s.annual, s.annualBase),
		};
	});
	return out;
}

const toPercent = (fraction: number | null) =>
	fraction === null ? null : fraction * 100;

/**
 * The Financial Impact box, as the view shows it: the typed values of the
 * Financial Impact section. A request with nothing typed falls back to the
 * summary-sheet sums, so older requests still print numbers.
 */
function financialOf(
	section: Record<string, unknown>,
	approvalAmount: number | null,
	fromSheet: Record<ImpactRow, PlantImpact>,
	impact: CppPdfData["impact"],
): { rows: Record<ImpactRow, FinancialRow>; total: FinancialRow } {
	const plants = asObject(section.plants);
	const typed = {} as Record<ImpactRow, FinancialRow>;
	let anyTyped = false;
	IMPACT_ROWS.forEach((key) => {
		const r = asObject(plants[key]);
		typed[key] = {
			actual: num(r.actualInr),
			actualPct: num(r.actualPct),
			annual: num(r.annualisedInr),
			annualPct: num(r.annualisedPct),
		};
		if (Object.values(typed[key]).some((v) => v !== null)) anyTyped = true;
	});
	const totalActualPct = num(section.totalActualPct);
	const totalAnnualPct = num(section.totalAnnualisedPct);

	const rows = anyTyped
		? typed
		: (Object.fromEntries(
				IMPACT_ROWS.map((key) => [
					key,
					{
						actual: fromSheet[key].actual,
						actualPct: toPercent(fromSheet[key].actualPct),
						annual: fromSheet[key].annual,
						annualPct: toPercent(fromSheet[key].annualPct),
					},
				]),
			) as Record<ImpactRow, FinancialRow>);

	const sumOf = (pick: (r: FinancialRow) => number | null) => {
		const values = IMPACT_ROWS.map((k) => pick(rows[k])).filter(
			(v): v is number => v !== null,
		);
		return values.length ? values.reduce((a, b) => a + b, 0) : null;
	};
	return {
		rows,
		total: {
			actual: sumOf((r) => r.actual) ?? impact.actual,
			actualPct: totalActualPct ?? toPercent(impact.actualPct),
			// The view prints the approval amount as the annual total.
			annual: approvalAmount ?? sumOf((r) => r.annual) ?? impact.annual,
			annualPct: totalAnnualPct ?? toPercent(impact.annualPct),
		},
	};
}

/* ---- per-plant master data (Master Data tab). Only applicable rows are saved. ---- */
type LocationRow = {
	code: string;
	name: string;
	group: string;
	incoTerms: string;
	purchasingGroup: string;
	taxCode: string;
	storeLocation: string;
	pfPct: string;
};

function locationRows(master: Record<string, unknown>): LocationRow[] {
	const list = Array.isArray(master.plantDetails) ? master.plantDetails : [];
	return list.map((p) => {
		const r = asObject(p);
		return {
			code: str(r.code),
			name: str(r.name),
			group: str(r.group),
			incoTerms: str(r.incoTerms),
			purchasingGroup: str(r.purchasingGroup),
			taxCode: str(r.taxCode),
			storeLocation: str(r.storeLocation),
			pfPct: str(r.pfPct),
		};
	});
}

/** One value when every row agrees ("BA"); otherwise "DWD: D07  KGP: T01". */
function perPlantText(
	rows: LocationRow[],
	pick: (r: LocationRow) => string,
	fallback = "",
): string {
	const values = rows
		.map((r) => ({ name: r.name || r.code, value: pick(r) }))
		.filter((v) => v.value);
	if (values.length === 0) return fallback;
	const distinct = new Set(values.map((v) => v.value));
	if (distinct.size === 1) return [...distinct][0];
	return values.map((v) => `${v.name}: ${v.value}`).join("  ");
}

// Order in which uploaded PDFs/images are appended (purchasingFile is Excel, so
// it is never merged).
const ATTACHMENT_ORDER = [
	"annualisedImpact",
	"modelImpact",
	"zbc",
	"commodityTrend",
	"ecn",
	"nesting",
	"comparativeQuote",
	"addDeleteList",
	"oldCost",
	"clpSpares",
	"steelApproval",
];

/* ---------------------------- workflow → signers --------------------------- */

type StageRow = {
	stageOrder: number;
	stageName: string | null;
	status: string | null;
	approvals: Array<{
		status: string;
		actedAt: Date | null;
		approver: {
			id: string;
			first_name: string;
			last_name: string;
			email: string | null;
			designation: { name: string } | null;
		};
	}>;
};

type Bucket =
	| "checkedBy"
	| "recommendedBy"
	| "approvedBy"
	| "committee"
	| "chairmen"
	| "managingDirector"
	| "skip";

/**
 * Stage names are `"<label> · <title>"` (see cpp.workflow.ts), e.g.
 * "Recommender · Category Head KGP/DWD". The buckets follow the on-screen sheet
 * (CppPdfView): Checker stages = Checked By, Recommender stages = Recommended
 * By, the other Approver stages = Approved By. Committee, chairmen and MD have
 * their own boxes.
 */
export function bucketForStage(stageName: string | null): Bucket {
	const name = (stageName ?? "").toLowerCase();
	if (!name) return "skip";
	if (name.includes("committee")) return "committee";
	if (name.includes("chairman")) return "chairmen";
	if (/managing director|\(md\)|\bmd\b/.test(name)) return "managingDirector";
	if (/price feeding|\btcs\b/.test(name)) return "skip";
	if (name.startsWith("checker")) return "checkedBy";
	if (name.startsWith("recommender")) return "recommendedBy";
	if (name.startsWith("approver")) return "approvedBy";
	return "skip";
}

const fullName = (u: { first_name: string | null; last_name: string | null }) =>
	`${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();

const toSigner = (a: StageRow["approvals"][number]): CppSigner => ({
	name: fullName(a.approver),
	designation: a.approver.designation?.name ?? null,
	status: a.status,
	actedAt: a.actedAt,
});

const latest = (signers: CppSigner[]): Date | null =>
	signers.reduce<Date | null>(
		(max, s) =>
			s.actedAt && s.status === "APPROVED" && (!max || s.actedAt > max)
				? s.actedAt
				: max,
		null,
	);

/* -------------------------------- audit trail ------------------------------ */

const ACTION_LABELS: Record<string, string> = {
	CPP_DRAFT_CREATED: "Draft created",
	CPP_SUBMITTED: "Submitted for approval",
	CPP_RESUBMITTED: "Resubmitted",
	CPP_CLOSED: "Closed by TCS",
	APPROVED: "Approved",
	REJECTED: "Rejected",
	CLARIFY: "Requested clarification",
	CLARIFIED: "Requested clarification",
	CLARIFICATION_REQUESTED: "Requested clarification",
	WORKFLOW_ASSIGNED: "Workflow assigned",
	WORKFLOW_STARTED: "Workflow started",
};

/** Raw action -> words. Unknown actions are shown title-cased, without the CPP_ prefix. */
export const auditActionLabel = (action: string): string => {
	const raw = action.trim().toUpperCase();
	if (ACTION_LABELS[raw]) return ACTION_LABELS[raw];
	const suffix = Object.keys(ACTION_LABELS).find((k) => raw.endsWith(`_${k}`));
	if (suffix) return ACTION_LABELS[suffix];
	return raw
		.replace(/^CPP_/, "")
		.toLowerCase()
		.split("_")
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
};

const STATUS_LABELS: Record<string, string> = {
	APPROVED: "Approved",
	PENDING: "Pending",
	IN_PROGRESS: "In progress",
	REJECTED: "Rejected",
	CLARIFY: "Clarification requested",
	CLARIFIED: "Clarification requested",
	SKIPPED: "Not needed",
	SUPERSEDED: "Superseded",
};
export const statusLabel = (status: string | null | undefined): string => {
	const s = str(status).toUpperCase();
	return STATUS_LABELS[s] ?? auditActionLabel(s);
};

/** The ActivityLog timestamp, whatever the column is called (created_at / createdAt). */
const logTime = (row: Record<string, unknown>): Date | null => {
	const value = row.created_at ?? row.createdAt;
	const date =
		value instanceof Date ? value : value ? new Date(String(value)) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};

type AuditUser = {
	id: string;
	first_name: string | null;
	last_name: string | null;
	email: string | null;
};

/**
 * Activity log rows for the request, plus any approval decision the log does
 * not already hold (matched on person + time), oldest first.
 */
async function loadAuditTrail(id: string): Promise<CppAuditRow[]> {
	const [logs, decisions] = await Promise.all([
		prisma.activityLog.findMany({
			where: { subjectType: CPP_SUBJECT_TYPE, subjectId: id },
		}),
		prisma.approval.findMany({
			where: {
				actedAt: { not: null },
				stage: { workflow: { subjectType: CPP_SUBJECT_TYPE, subjectId: id } },
			},
			select: {
				status: true,
				actedAt: true,
				approverId: true,
				stage: { select: { stageName: true } },
			},
		}),
	]);
	const logRows = logs as unknown as Array<Record<string, unknown>>;

	const userIds = [
		...new Set([
			...logRows.map((l) => str(l.actorId)).filter(Boolean),
			...decisions.map((d) => d.approverId),
		]),
	];
	const users = userIds.length
		? await prisma.user.findMany({
				where: { id: { in: userIds } },
				select: { id: true, first_name: true, last_name: true, email: true },
			})
		: [];
	const nameOf = new Map<string, string>(
		users.map((u: AuditUser) => [u.id, fullName(u) || str(u.email)]),
	);

	const used = new Set<number>();
	const rows: CppAuditRow[] = [];
	for (const log of logRows) {
		const at = logTime(log);
		if (!at) continue;
		const meta = asObject(log.metadata);
		const actorId = str(log.actorId);
		// Same person, within 2 minutes: the log entry IS that approval decision.
		const matchIndex = decisions.findIndex(
			(d, i) =>
				!used.has(i) &&
				d.approverId === actorId &&
				d.actedAt !== null &&
				Math.abs(d.actedAt.getTime() - at.getTime()) < 2 * 60 * 1000,
		);
		if (matchIndex >= 0) used.add(matchIndex);
		rows.push({
			at,
			action: auditActionLabel(str(log.action)),
			by: nameOf.get(actorId) ?? (actorId ? "" : "System"),
			stage:
				str(meta.stageName) ||
				(matchIndex >= 0 ? str(decisions[matchIndex].stage.stageName) : ""),
			remarks: str(meta.reason) || str(meta.remarks) || str(meta.comment),
		});
	}
	decisions.forEach((d, i) => {
		if (used.has(i) || !d.actedAt || d.status === "PENDING") return;
		rows.push({
			at: d.actedAt,
			action: statusLabel(d.status),
			by: nameOf.get(d.approverId) ?? "",
			stage: str(d.stage.stageName),
			remarks: "",
		});
	});
	return rows.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/* -------------------------------- assembler -------------------------------- */

export async function assembleCppPdfData(id: string): Promise<CppPdfData> {
	const request = await prisma.cppRequest.findUnique({
		where: { id },
		include: {
			attachments: {
				select: {
					type: true,
					fileName: true,
					s3Key: true,
					uploadedAt: true,
					parsedData: true,
				},
				orderBy: { uploadedAt: "asc" },
			},
		},
	});
	if (!request) throw new ApiError(404, "CPP request not found");

	const [initiator, workflow, auditTrail] = await Promise.all([
		prisma.user.findUnique({
			where: { id: request.initiatedById },
			select: {
				first_name: true,
				last_name: true,
				designation: { select: { name: true } },
			},
		}),
		prisma.workflowInstance.findFirst({
			where: { subjectType: CPP_SUBJECT_TYPE, subjectId: id, isActive: true },
			orderBy: { created_at: "desc" },
			select: {
				stages: {
					where: { isCurrentIteration: true },
					orderBy: { stageOrder: "asc" },
					select: {
						stageOrder: true,
						stageName: true,
						status: true,
						approvals: {
							select: {
								status: true,
								actedAt: true,
								approver: {
									select: {
										id: true,
										first_name: true,
										last_name: true,
										email: true,
										designation: { select: { name: true } },
									},
								},
							},
						},
					},
				},
			},
		}),
		loadAuditTrail(id),
	]);

	/* ---- who is Alt Chairman and who is Chairman (one parallel stage) ---- */
	const stages: StageRow[] = (workflow?.stages ?? []) as StageRow[];
	const chairmanStage = stages.some(
		(s) => bucketForStage(s.stageName) === "chairmen",
	);
	const chairmanRoles = new Map<string, string>(); // userId → roleKey
	if (chairmanStage) {
		const seats = await prisma.cppSlotAssignment.findMany({
			where: {
				workspaceId: request.workspaceId,
				roleKey: { in: ["ALT_CHAIRMAN", "CHAIRMAN"] },
			},
			select: { roleKey: true, userId: true },
		});
		seats.forEach((s) => chairmanRoles.set(s.userId, s.roleKey));
	}

	const buckets: Record<Bucket, CppSigner[]> = {
		checkedBy: [],
		recommendedBy: [],
		approvedBy: [],
		committee: [],
		chairmen: [],
		managingDirector: [],
		skip: [],
	};
	const altChairman: CppSigner[] = [];
	const chairman: CppSigner[] = [];
	const workflowRows: CppWorkflowRow[] = [];

	for (const stage of stages) {
		const bucket = bucketForStage(stage.stageName);
		const phase: CppWorkflowRow["phase"] =
			bucket === "committee" ||
			bucket === "chairmen" ||
			bucket === "managingDirector"
				? "WF2"
				: "WF1";
		for (const approval of stage.approvals) {
			const signer = toSigner(approval);
			if (bucket === "chairmen") {
				(chairmanRoles.get(approval.approver.id) === "ALT_CHAIRMAN"
					? altChairman
					: chairman
				).push(signer);
			} else {
				buckets[bucket].push(signer);
			}
			workflowRows.push({
				phase,
				stageOrder: stage.stageOrder,
				stageName: str(stage.stageName),
				stageStatus: str(stage.status),
				approver: signer.name,
				designation: signer.designation ?? "",
				email: str(approval.approver.email),
				status: approval.status,
				actedAt: approval.actedAt,
			});
		}
	}

	/* ---- sections ---- */
	const basic = sectionDataOf(request.sections, "basic");
	const purchasing = sectionDataOf(request.sections, "purchasing");
	const master = sectionDataOf(request.sections, "master");
	const volumes = sectionDataOf(request.sections, "volumes");
	const other = sectionDataOf(request.sections, "other");
	const suppliers = asObject(purchasing.suppliers);
	const flow = asObject(basic.workflow);

	/* ---- part rows: the summary sheet (part info) when it was uploaded. The
	        purchasing Excel is only read for requests saved before that, and
	        never fatal ---- */
	let parts: CppPartRows = EMPTY_PART_ROWS;
	let partsFileName: string | null = null;
	const summaryFile = request.attachments.find((a) => a.type === "partSummary");
	const summaryRows = summaryRowsOf(summaryFile?.parsedData);
	const purchasingFile = request.attachments.find(
		(a) => a.type === "purchasingFile",
	);
	if (summaryFile && summaryRows.length > 0) {
		parts = { summary: summaryRows, pir: [], pirHeader: null };
		partsFileName = summaryFile.fileName;
	} else if (purchasingFile) {
		try {
			const buffer = await downloadFromS3(purchasingFile.s3Key);
			if (buffer.length <= CPP_MAX_PARSE_BYTES) {
				parts = parseCppPartRows(buffer);
				partsFileName = purchasingFile.fileName;
			}
		} catch (error) {
			logger.warn(
				`CPP PDF: could not read purchasing file for ${request.referenceNumber}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const partLines = parts.summary.filter(
		(l): l is CppSummaryRow => l.kind === "part",
	);

	/* ---- impact (summary-sheet page): the Excel wins (it has the
	        percentages); the request's own totals fill in otherwise ---- */
	const fromFile = summariseImpact(parts.summary);
	const impact = {
		actual: fromFile.actual ?? num(request.actualImpact),
		annual:
			fromFile.annual ??
			num(request.annualisedImpact) ??
			num(request.annualisedValue),
		actualPct: fromFile.actualPct,
		annualPct: fromFile.annualPct,
	};
	const financial = financialOf(
		sectionDataOf(request.sections, "financial"),
		num(asObject(purchasing.approvalValues).amount),
		impactByPlantOf(partLines),
		impact,
	);

	/* ---- master data: only applicable rows are saved (cpp.mapper.ts) ---- */
	const locations = locationRows(master);
	const plantLocations = locations.filter((r) => r.group === "PLANT");
	const spareLocations = locations.filter((r) => r.group === "SPARE");

	const volume = (key: ImpactRow) => {
		const v = asObject(asObject(volumes.volumes)[key]);
		return {
			received: str(v.received),
			remaining: str(v.remaining),
			annual: str(v.annual),
		};
	};

	const checklistAnswers = asObject(other.checklist);

	const hasMd = buckets.managingDirector.length > 0;
	const hasCommittee = buckets.committee.length > 0;
	// Same rule as the view: the saved authority, else the title of the last
	// approval stage (price feeding / TCS are not approvals).
	const lastStage = stages
		.filter((s) => !/price feeding|\btcs\b/i.test(s.stageName ?? ""))
		.pop();
	const approvingAuthority =
		str(flow.authority) ||
		str(lastStage?.stageName?.split("·").pop()) ||
		(request.isSpare
			? "Spare"
			: hasMd
				? "MD"
				: hasCommittee || chairmanStage
					? "CPP"
					: "");

	const mergeable = request.attachments
		.filter(
			(a) =>
				a.type !== "purchasingFile" &&
				a.type !== "partSummary" &&
				MERGEABLE_EXTENSIONS.has(path.extname(a.s3Key).toLowerCase()),
		)
		.sort(
			(a, b) =>
				ATTACHMENT_ORDER.indexOf(a.type) - ATTACHMENT_ORDER.indexOf(b.type),
		);

	return {
		referenceNumber: request.referenceNumber,
		status: request.status,
		date:
			isoDate(basic.initiationDate) ??
			request.submittedAt ??
			request.created_at,
		category: str(request.category),
		plant: str(request.plant),
		condition: str(request.condition),
		isSpare: request.isSpare,

		reason: str(basic.reason),
		effects: strList(basic.effects),
		materialType: str(basic.materialType),
		priceType: str(basic.priceType).toUpperCase(),
		pricingCondition: str(flow.pricingCondition),
		justification: str(basic.justification),
		models: strList(flow.models),
		applicablePlants: strList(flow.plants),
		applicableCodes: locations.map((r) => r.code).filter(Boolean),

		suppliers: {
			existing: supplierOf(suppliers.existing),
			other: supplierOf(suppliers.other),
			recommended: supplierOf(suppliers.recommended).name
				? supplierOf(suppliers.recommended)
				: { name: str(request.supplierName), code: str(request.supplierCode) },
		},
		master: {
			incoTerms: perPlantText(
				plantLocations,
				(r) => r.incoTerms,
				str(master.incoTerms),
			),
			purchasingGroup: perPlantText(
				plantLocations,
				(r) => r.purchasingGroup,
				str(master.purchasingGroup),
			),
			taxCode: perPlantText(
				plantLocations,
				(r) => r.taxCode,
				str(master.taxCode),
			),
			storeLocation: perPlantText(
				plantLocations,
				(r) => r.storeLocation,
				str(master.storeLocation),
			),
		},
		spares: {
			incoTerms: perPlantText(spareLocations, (r) => r.incoTerms),
			pfPct: perPlantText(spareLocations, (r) => r.pfPct),
			taxCode: perPlantText(spareLocations, (r) => r.taxCode),
		},

		formParts: partLines.slice(0, MAX_FORM_PARTS).map((p) => ({
			partNo: p.partNo,
			description: p.description,
			uom: p.uom,
			existingPrice: p.existingPrice,
			newPrice: p.newPrice,
			effectiveDate: p.effectiveDate,
			pctChange: p.pctChange,
		})),
		partCount: partLines.length,

		impact,
		financial: financial.rows,
		financialTotal: financial.total,

		amortisation: textRows(sectionDataOf(request.sections, "amortisation").rows, [
			"partNo",
			"priceInclAmort",
			"cutoffDate",
			"amortQty",
			"priceAfterAmort",
		]),
		perMachine: textRows(volumes.perMachineImpact, [
			"plant",
			"model",
			"withAmort",
			"withoutAmort",
		]),
		volumes: { KGP: volume("KGP"), DWD: volume("DWD"), SPARE: volume("SPARE") },
		plantPrices: textRows(other.plantPrices, ["plant", "partNumber", "price"]),
		costTracker: textRows(volumes.costTracker, [
			"model",
			"perMachineImpact",
			"budgetedIncrease",
			"statusYtd",
			"budgetedMaterialCost",
			"materialCostYtd",
		]),

		approvingAuthority,

		proposer: initiator
			? {
					name: fullName(initiator),
					designation: initiator.designation?.name ?? null,
					status: "APPROVED",
					actedAt: request.submittedAt,
				}
			: null,
		checkedBy: buckets.checkedBy,
		recommendedBy: buckets.recommendedBy,
		approvedBy: buckets.approvedBy,
		committee: buckets.committee,
		altChairman,
		chairman,
		managingDirector: buckets.managingDirector,
		cppDate: latest([...buckets.committee, ...altChairman, ...chairman]),
		mdDate: latest(buckets.managingDirector),

		checklist: CHECKLIST.map((c) => ({
			label: c.label,
			value: str(checklistAnswers[c.key]),
		})),

		workflowRows,
		auditTrail,

		parts,
		partsFileName,
		attachments: mergeable,
		updatedAt: request.updated_at,
		uploadsFingerprint: request.attachments
			.map((a) => `${a.type}:${a.s3Key}:${a.uploadedAt.toISOString()}`)
			.sort()
			.join("|"),
		generatedAt: new Date(),
	};
}

/** S3 keys of the uploaded PDFs / images to append after the generated pages. */
export function getCppAttachmentS3Keys(data: CppPdfData): string[] {
	return data.attachments.map((a) => a.s3Key);
}

/**
 * Fingerprint of everything the printed form shows. The registry uses it as a
 * cache-key suffix, so an edit, a new approval, a new audit entry or a new
 * upload produces a fresh PDF instead of serving a stale one.
 */
export function computeCppCacheVersion(data: CppPdfData): string {
	const people = (list: CppSigner[]) =>
		list
			.map((s) => `${s.name}:${s.status}:${s.actedAt?.toISOString() ?? ""}`)
			.join(",");
	const lastAudit = data.auditTrail[data.auditTrail.length - 1];
	const fingerprint = [
		data.updatedAt.toISOString(),
		data.status,
		people(data.checkedBy),
		people(data.recommendedBy),
		people(data.approvedBy),
		people(data.committee),
		people(data.altChairman),
		people(data.chairman),
		people(data.managingDirector),
		data.workflowRows
			.map((r) => `${r.stageOrder}:${r.email}:${r.status}`)
			.join(","),
		`${data.auditTrail.length}:${lastAudit?.at.toISOString() ?? ""}`,
		data.uploadsFingerprint,
	].join("#");
	return createHash("sha1").update(fingerprint).digest("hex").slice(0, 10);
}

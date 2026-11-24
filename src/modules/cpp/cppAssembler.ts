import { createHash } from "crypto";
import path from "path";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";
import logger from "@shared/utils/logger";

import {
	EMPTY_PART_ROWS,
	parseCppPartRows,
	summariseImpact,
	type CppPartRows,
	type CppSummaryRow,
} from "./cppPartRows";
import { plantCodeOf } from "./cpp.plants";

// ─────────────────────────────────────────────────────────────────────────────
// CPP — PDF DATA ASSEMBLER
//
// Fetches the request, who initiated it, its current-iteration workflow and
// the uploaded files, and shapes them for cppDocDefinition.ts. Knows nothing
// about pdfmake. The approval workflow is NOT re-derived here: the people on
// the form are the approvers the engine really assigned to the request.
// ─────────────────────────────────────────────────────────────────────────────

const CPP_SUBJECT = "CPP_REQUEST";
/** Never read an upload bigger than this just to print a summary page. */
const MAX_PART_FILE_BYTES = 8 * 1024 * 1024;
const MERGEABLE_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

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

export interface CppPdfData {
	referenceNumber: string;
	status: string;
	/** Printed next to "Approval Ref." */
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

	suppliers: {
		existing: CppPdfSupplier;
		other: CppPdfSupplier;
		recommended: CppPdfSupplier;
	};
	master: {
		incoTerms: string;
		purchasingGroup: string;
		taxCode: string;
		storeLocation: string;
	};

	impact: {
		actual: number | null;
		annual: number | null;
		actualPct: number | null; // fraction
		annualPct: number | null;
	};
	/** Financial Impact rows: KGP, DWD and SPARE (summary-sheet rows summed per plant). */
	impactByPlant: Record<ImpactRow, PlantImpact>;

	/** MD | CPP | SCM | Spare — who finally approves, derived from the stages. */
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

	/** Mandatory Check List: the Yes / No / NA the proposer saved (or Yes when a document is attached). */
	checklist: Array<{ label: string; value: string }>;

	parts: CppPartRows;
	/** Name of the purchasingFile that the parts came from (for the footer). */
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

const asRecord = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

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
	const s = asRecord(v);
	return { name: str(s.name), code: str(s.code) };
};

const numOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const textOf = (value: unknown): string =>
	value === null || value === undefined ? "" : String(value);

/** Parsed summary-sheet rows (cpp.partSummary.ts) -> the part lines the PDF reads. */
function summaryRowsOf(parsed: unknown): CppSummaryRow[] {
	const rows = asRecord(parsed).rows;
	if (!Array.isArray(rows)) return [];
	return rows.map((r) => {
		const row = asRecord(r);
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

function sectionData(sections: unknown, key: string): Record<string, unknown> {
	const list = Array.isArray(sections) ? sections : [];
	const found = list.find((s) => asRecord(s).key === key);
	return asRecord(asRecord(found).data);
}

/* Mandatory Check List: the saved answer (other.checklist) wins; when none is
 * saved, a matching attachment means "Yes". */
const CHECKLIST: Array<{ label: string; key: string; types: string[] }> = [
	{
		label: "1) Annualized Impact Cal.",
		key: "annualisedImpact",
		types: ["annualisedImpact"],
	},
	{
		label: "2) Model wise Impact Cal.",
		key: "modelImpact",
		types: ["modelImpact"],
	},
	{ label: "3) ZBC Calculation", key: "zbc", types: ["zbc"] },
	{
		label: "4) Commodity Price Trend",
		key: "commodityTrend",
		types: ["commodityTrend"],
	},
	{ label: "5) ECN attached", key: "ecn", types: ["ecn"] },
	{ label: "6) Nesting Calculation", key: "nesting", types: ["nesting"] },
	{
		label: "7) Comparative Quote./Ana.",
		key: "comparativeQuote",
		types: ["comparativeQuote"],
	},
];

/* ---- Financial Impact rows: the form shows KGP, DWD and SPARE ---- */
export type ImpactRow = "KGP" | "DWD" | "SPARE";
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
	(Object.keys(acc) as ImpactRow[]).forEach((k) => {
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

/* ---- per-plant master data (Master Data tab): the source the submit check uses ---- */
type PlantMasterRow = {
	name: string;
	incoTerms: string;
	purchasingGroup: string;
	taxCode: string;
	storeLocation: string;
};

function plantMasterRows(
	master: Record<string, unknown>,
	applicable: string[],
): PlantMasterRow[] {
	const list = Array.isArray(master.plantDetails) ? master.plantDetails : [];
	return list
		.map((p) => {
			const r = asRecord(p);
			return {
				name: str(r.name),
				incoTerms: str(r.incoTerms),
				purchasingGroup: str(r.purchasingGroup),
				taxCode: str(r.taxCode),
				storeLocation: str(r.storeLocation),
			};
		})
		.filter((r) => applicable.length === 0 || applicable.includes(r.name));
}

/** One value when every applicable plant agrees ("BA"); otherwise "DWD: D07  KGP: T01". */
function perPlantText(
	rows: PlantMasterRow[],
	pick: (r: PlantMasterRow) => string,
	fallback: string,
): string {
	const values = rows
		.map((r) => ({ name: r.name, value: pick(r) }))
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
	approvals: Array<{
		status: string;
		actedAt: Date | null;
		approver: {
			id: string;
			first_name: string;
			last_name: string;
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
 * "Recommender · Category Head KGP/DWD". Buckets follow the printed form:
 * Checked By = category / component / cost people, Recommended By = the plant
 * SCM head, Approved By = the remaining WF1 approvers.
 */
export function bucketForStage(stageName: string | null): Bucket {
	const name = (stageName ?? "").toLowerCase();
	if (!name) return "skip";
	if (name.includes("committee")) return "committee";
	if (name.includes("chairman")) return "chairmen";
	if (/managing director|\(md\)|\bmd\b/.test(name)) return "managingDirector";
	if (name.startsWith("recommender") || name.startsWith("checker"))
		return "checkedBy";
	if (
		name.startsWith("approver") &&
		/head scm kgp|head scm dwd|scm kgp plant/.test(name)
	)
		return "recommendedBy";
	if (name.startsWith("approver")) return "approvedBy";
	return "skip";
}

const fullName = (u: { first_name: string; last_name: string }) =>
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

	const [initiator, workflow] = await Promise.all([
		prisma.user.findUnique({
			where: { id: request.initiatedById },
			select: {
				first_name: true,
				last_name: true,
				designation: { select: { name: true } },
			},
		}),
		prisma.workflowInstance.findFirst({
			where: { subjectType: CPP_SUBJECT, subjectId: id, isActive: true },
			orderBy: { created_at: "desc" },
			select: {
				stages: {
					where: { isCurrentIteration: true },
					orderBy: { stageOrder: "asc" },
					select: {
						stageOrder: true,
						stageName: true,
						approvals: {
							select: {
								status: true,
								actedAt: true,
								approver: {
									select: {
										id: true,
										first_name: true,
										last_name: true,
										designation: { select: { name: true } },
									},
								},
							},
						},
					},
				},
			},
		}),
	]);

	/* ---- who is Alt Chairman and who is Chairman (one parallel stage) ---- */
	const stages: StageRow[] = (workflow?.stages ?? []) as StageRow[];
	const chairmanStage = stages.some(
		(s) => bucketForStage(s.stageName) === "chairmen",
	);
	const chairmanRoles = new Map<string, string>(); // userId → roleKey
	if (chairmanStage) {
		const seats = await prisma.cppSlotAssignment.findMany({
			where: { roleKey: { in: ["ALT_CHAIRMAN", "CHAIRMAN"] } },
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

	for (const stage of stages) {
		const bucket = bucketForStage(stage.stageName);
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
		}
	}

	/* ---- sections ---- */
	const basic = sectionData(request.sections, "basic");
	const purchasing = sectionData(request.sections, "purchasing");
	const master = sectionData(request.sections, "master");
	const suppliers = asRecord(purchasing.suppliers);
	const flow = asRecord(basic.workflow);

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
			if (buffer.length <= MAX_PART_FILE_BYTES) {
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

	/* ---- impact: the Excel wins (it has the percentages); the request's own
	        saved totals fill in when the Excel could not be read ---- */
	const fromFile = summariseImpact(parts.summary);
	/* The annual figure for first-time / regular bands is the request's annualised
	 * value (the approval amount the form shows), so it is the fallback when no
	 * annualised impact has been saved. */
	const impact = {
		actual: fromFile.actual ?? num(request.actualImpact),
		annual:
			fromFile.annual ??
			num(request.annualisedImpact) ??
			num(request.annualisedValue),
		actualPct: fromFile.actualPct,
		annualPct: fromFile.annualPct,
	};
	const impactByPlant = impactByPlantOf(
		parts.summary.filter((l): l is CppSummaryRow => l.kind === "part"),
	);

	/* Master data is saved per plant (Master Data tab); the applicable plants
	 * (DWD / KGP) pick the rows. The top-level fields are only a fallback. */
	const applicablePlants = strList(flow.plants);
	const plantRows = plantMasterRows(master, applicablePlants);
	const masterText = {
		incoTerms: perPlantText(
			plantRows,
			(r) => r.incoTerms,
			str(master.incoTerms),
		),
		purchasingGroup: perPlantText(
			plantRows,
			(r) => r.purchasingGroup,
			str(master.purchasingGroup),
		),
		taxCode: perPlantText(plantRows, (r) => r.taxCode, str(master.taxCode)),
		storeLocation: perPlantText(
			plantRows,
			(r) => r.storeLocation,
			str(master.storeLocation),
		),
	};

	const checklistAnswers = asRecord(
		sectionData(request.sections, "other").checklist,
	);
	const attachedTypes = new Set(request.attachments.map((a) => a.type));

	const hasMd = buckets.managingDirector.length > 0;
	const hasCommittee = buckets.committee.length > 0;
	const approvingAuthority = request.isSpare
		? "Spare"
		: hasMd
			? "MD"
			: hasCommittee || chairmanStage
				? "CPP"
				: stages.length > 0
					? "SCM"
					: "";

	const mergeable = request.attachments
		.filter(
			(a) =>
				a.type !== "purchasingFile" &&
				MERGEABLE_EXTENSIONS.has(path.extname(a.s3Key).toLowerCase()),
		)
		.sort(
			(a, b) =>
				ATTACHMENT_ORDER.indexOf(a.type) - ATTACHMENT_ORDER.indexOf(b.type),
		);

	return {
		referenceNumber: request.referenceNumber,
		status: request.status,
		date: request.submittedAt ?? request.created_at,
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
		applicablePlants,

		suppliers: {
			existing: supplierOf(suppliers.existing),
			other: supplierOf(suppliers.other),
			recommended: supplierOf(suppliers.recommended).name
				? supplierOf(suppliers.recommended)
				: { name: str(request.supplierName), code: str(request.supplierCode) },
		},
		master: masterText,

		impact,
		impactByPlant,
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

		checklist: CHECKLIST.map((c) => {
			const saved = str(checklistAnswers[c.key]);
			const attached = c.types.some((t) => attachedTypes.has(t));
			return { label: c.label, value: saved || (attached ? "Yes" : "NA") };
		}),

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
 * cache-key suffix, so an edit, a new approval or a new upload produces a fresh
 * PDF instead of serving a stale one.
 */
export function computeCppCacheVersion(data: CppPdfData): string {
	const people = (list: CppSigner[]) =>
		list
			.map((s) => `${s.name}:${s.status}:${s.actedAt?.toISOString() ?? ""}`)
			.join(",");
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
		data.uploadsFingerprint,
	].join("#");
	return createHash("sha1").update(fingerprint).digest("hex").slice(0, 10);
}

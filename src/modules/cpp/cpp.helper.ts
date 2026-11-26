// cpp.helper.ts — CPP logic: no req/res, no Prisma client, no S3. All pure
// except the one mail re-export below. Unit tested on its own (cpp.spec.ts).
//
//   sections        validate / merge / read the per-tab JSON sections
//   section readers the few values other files read out of the sections
//   payload         request body -> Prisma data (derived listing + band columns)
//   submit checks   what must be filled before a request enters approval
//   responses       list item / detail shapes, pending-on
//   listing         tab / paging / search / sort
//   files           file-name helpers
//   matrix          coverage checks, save validation, replace-user plan
//
// Shapes the PDF / export read from the uploaded Excel live in cpp.sheet.ts.
import ApiError from "@shared/utils/apiError";
import { type Prisma } from "../../prisma/generated/prisma/client";
import type { PendingOn } from "@kernel/workflow/workflowSubject.helper";

import {
	ASSIGNABLE_ROLES,
	CPP_APPLICABLE_PLANTS,
	CPP_DEFAULT_PAGE_SIZE,
	CPP_EFFECTS,
	CPP_LISTING_SORT_FIELDS,
	CPP_LOCATION_CODES,
	CPP_MAX_PAGE_SIZE,
	CPP_PRICE_TYPES,
	CPP_SLOT_SCOPES,
	CPP_STATUS,
	CPP_TCS_ROLE_KEY,
	getRole,
	isCppStatus,
	isValidSlot,
	plantCodeOf,
	scopesForRole,
	slotKey,
} from "./cpp.constants";
import {
	CPP_CATEGORIES,
	CPP_CONDITION_CODES,
	CPP_PLANTS,
	getConditionDef,
	resolveCombination,
	roleUsage,
} from "./cpp.rules";
import { readStoredPartSummary, type PartSummaryRow } from "./cpp.sheet";

// The approved mail lives in cpp.mail.ts. Re-exported so the kernel final-approval
// hook (workflowSubject.helper.ts) keeps working whether it imports the mail
// function from cpp.helper or from cpp.mail. Same as before the refactor.
export { notifyCppApproved, sendCppApprovedMail } from "./cpp.mail";

type Json = Record<string, unknown>;

/* ===== small readers (shared by every CPP file) ===== */

export const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Plain object or {}. */
export const asObject = (value: unknown): Json => (isObject(value) ? value : {});

/** Trimmed text of a string / number / boolean; "" for anything else. */
export const str = (value: unknown): string =>
	typeof value === "string"
		? value.trim()
		: typeof value === "number" || typeof value === "boolean"
			? String(value)
			: "";

export const fullName = (u: {
	first_name: string | null;
	last_name: string | null;
}): string => [u.first_name, u.last_name].filter(Boolean).join(" ").trim();

const has = (obj: Json, key: string) =>
	Object.prototype.hasOwnProperty.call(obj, key);

/* ===== sections ===== */
// A CPP request is saved as an array of sections, one per wizard tab:
//   [{ key: "basic", label: "Basic details", data: { … } }, …]
// The server owns the shape: unknown keys are dropped, types and lengths are
// checked, and an empty section always comes back with every field present, so
// the UI never meets `undefined`. Files are NOT part of the sections — they are
// separate uploads (cpp_attachment).
//
// Requests saved before a section existed ("financial", "amortisation",
// "volumes") get it back empty (defaultSectionData), so no migration is needed.

export const CPP_SECTION_KEYS = [
	"basic",
	"purchasing",
	"amortisation",
	"volumes",
	"financial",
	"master",
	"other",
] as const;
export type CppSectionKey = (typeof CPP_SECTION_KEYS)[number];

export const CPP_SECTION_LABELS: Record<CppSectionKey, string> = {
	basic: "Basic details",
	purchasing: "Purchasing details",
	amortisation: "Amortisation",
	volumes: "Volumes & impact",
	financial: "Financial impact",
	master: "Master data",
	other: "Other data",
};

type Spec =
	| { t: "text"; max: number }
	| { t: "date" }
	| { t: "decimal" }
	| { t: "bool" }
	| { t: "oneOf"; allowed: readonly string[] }
	| { t: "list"; max: number; item: number; allowed?: readonly string[] }
	| { t: "object"; fields: Record<string, Spec> }
	/** List of objects (table rows). Every row is cleaned with `fields`. */
	| { t: "rows"; max: number; fields: Record<string, Spec> };

const text = (max: number): Spec => ({ t: "text", max });
const obj = (fields: Record<string, Spec>): Spec => ({ t: "object", fields });
const tableRows = (max: number, fields: Record<string, Spec>): Spec => ({
	t: "rows",
	max,
	fields,
});
const decimal: Spec = { t: "decimal" };

/** Same cap as the form (CPP_MAX_TABLE_ROWS). */
const CPP_MAX_TABLE_ROWS = 20;

const supplier = obj({
	partnerId: text(60),
	name: text(200),
	code: text(40),
	manual: { t: "bool" },
});

/** Plant rows of the Financial Impact box. Same keys as the frontend CppPlant. */
export const CPP_FINANCIAL_PLANTS = ["KGP", "DWD", "SPARE"] as const;

/** "Volumes Taken For Calculation": a / b for actual, c for annualised. */
const volume = obj({ received: decimal, remaining: decimal, annual: decimal });

/** One plant row: +ve = price increase, -ve = price decrease. */
const financialRow = obj({
	actualInr: decimal,
	actualPct: decimal,
	annualisedInr: decimal,
	annualisedPct: decimal,
});

/** Mandatory Check List answers (CPP_CHECKLIST on the frontend). */
const MANDATORY_CHECKLIST = [
	"annualisedImpact",
	"modelImpact",
	"zbc",
	"commodityTrend",
	"ecn",
	"nesting",
	"comparativeQuote",
] as const;
const checklistAnswer: Spec = { t: "oneOf", allowed: ["", "Yes", "No", "NA"] };

const SPECS: Record<CppSectionKey, Spec> = {
	basic: obj({
		materialType: { t: "oneOf", allowed: ["", "Direct", "Indirect"] },
		effects: { t: "list", max: 3, item: 20, allowed: CPP_EFFECTS },
		reason: text(120),
		priceType: { t: "oneOf", allowed: ["", ...CPP_PRICE_TYPES] },
		justification: text(2000),
		initiationDate: { t: "date" },
		workflow: obj({
			models: { t: "list", max: 50, item: 60 },
			plants: { t: "list", max: 3, item: 10, allowed: CPP_APPLICABLE_PLANTS },
			pricingCondition: text(20),
		}),
	}),
	purchasing: obj({
		suppliers: obj({ existing: supplier, other: supplier, recommended: supplier }),
		approvalValues: obj({
			partValue: decimal,
			variationPct: decimal,
			amount: decimal,
			// Summary-sheet part each value was picked from ("PLANT::PARTNO"), "" when typed.
			partValuePart: text(80),
			amountPart: text(80),
			// Ranges picked in the approval dropdowns (frontend utils/cpp.bands.ts), as band
			// keys like "10000_100000". They decide the band (see pickRule in cpp.workflow.ts).
			// FIX: these two were missing here, so the sanitizer dropped them and every
			// request routed on the typed numbers instead of the picked ranges.
			partBand: text(40),
			amountBand: text(40),
		}),
	}),
	// "In case of Amortisation Only" — filled only for pricing condition PB50.
	amortisation: obj({
		rows: tableRows(CPP_MAX_TABLE_ROWS, {
			partNo: text(40),
			priceInclAmort: decimal,
			cutoffDate: { t: "date" },
			amortQty: decimal,
			priceAfterAmort: decimal,
		}),
	}),
	// Optional tables. Tracker values are ₹ lakhs; per-machine impact is ₹.
	volumes: obj({
		volumes: obj({ DWD: volume, KGP: volume, SPARE: volume }),
		perMachineImpact: tableRows(CPP_MAX_TABLE_ROWS, {
			plant: { t: "oneOf", allowed: ["", "DWD", "KGP", "SPARE"] },
			model: text(60),
			withAmort: decimal,
			withoutAmort: decimal,
		}),
		costTracker: tableRows(CPP_MAX_TABLE_ROWS, {
			model: text(60),
			perMachineImpact: decimal,
			budgetedIncrease: decimal,
			statusYtd: decimal,
			budgetedMaterialCost: decimal,
			materialCostYtd: decimal,
		}),
	}),
	financial: obj({
		plants: obj({ KGP: financialRow, DWD: financialRow, SPARE: financialRow }),
		totalActualPct: decimal,
		totalAnnualisedPct: decimal,
	}),
	master: obj({
		materialGroup: text(80),
		materialType: text(40),
		purchasingGroup: text(40),
		incoTerms: text(20),
		taxCode: text(20),
		storeLocation: text(60),
		validFrom: { t: "date" },
		updateSourceList: text(10),
		note: text(1000),
		// Applicable plant / spare codes only. Code + purchasing group + tax code feed the
		// TCS text files (ZINFOUPDATE_ME11, ZCHANGEINFO).
		plantDetails: tableRows(CPP_LOCATION_CODES.length, {
			code: { t: "oneOf", allowed: CPP_LOCATION_CODES },
			name: text(20),
			group: { t: "oneOf", allowed: ["PLANT", "SPARE"] },
			incoTerms: text(20),
			purchasingGroup: text(10),
			taxCode: text(20),
			storeLocation: text(60),
			pfPct: decimal,
		}),
	}),
	other: obj({
		remarks: text(2000),
		// Mandatory Check List: Yes / No / NA per row.
		checklist: obj(Object.fromEntries(MANDATORY_CHECKLIST.map((key) => [key, checklistAnswer]))),
		// "Price in Other Plant Location (if any)".
		plantPrices: tableRows(CPP_MAX_TABLE_ROWS, {
			plant: text(20),
			partNumber: text(40),
			price: decimal,
		}),
	}),
};

const clean = (value: unknown, spec: Spec, path: string): unknown => {
	switch (spec.t) {
		case "text": {
			if (value === undefined || value === null) return "";
			if (typeof value !== "string") throw new ApiError(400, `${path} must be text`);
			const out = value.trim();
			if (out.length > spec.max)
				throw new ApiError(400, `${path} is too long (max ${spec.max} characters)`);
			return out;
		}
		case "date": {
			if (value === undefined || value === null || value === "") return "";
			if (
				typeof value !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
				Number.isNaN(Date.parse(value))
			)
				throw new ApiError(400, `${path} must be a date (YYYY-MM-DD)`);
			return value;
		}
		case "decimal": {
			if (value === undefined || value === null || value === "") return "";
			return parseDecimal(value, path) ?? "";
		}
		case "bool":
			return value === true;
		case "oneOf": {
			const out = value === undefined || value === null ? "" : value;
			if (typeof out !== "string" || !spec.allowed.includes(out))
				throw new ApiError(
					400,
					`${path} must be one of: ${spec.allowed.filter(Boolean).join(", ")}`,
				);
			return out;
		}
		case "list": {
			if (value === undefined || value === null) return [];
			if (!Array.isArray(value)) throw new ApiError(400, `${path} must be a list`);
			if (value.length > spec.max)
				throw new ApiError(400, `${path} has too many entries (max ${spec.max})`);
			const items = value.map((item) => {
				if (typeof item !== "string" || item.trim() === "" || item.length > spec.item)
					throw new ApiError(400, `${path} contains an invalid value`);
				if (spec.allowed && !spec.allowed.includes(item))
					throw new ApiError(400, `${path} has an invalid value "${item}"`);
				return item.trim();
			});
			return [...new Set(items)];
		}
		case "rows": {
			if (value === undefined || value === null) return [];
			if (!Array.isArray(value)) throw new ApiError(400, `${path} must be a list`);
			if (value.length > spec.max)
				throw new ApiError(400, `${path} has too many rows (max ${spec.max})`);
			const rowSpec = obj(spec.fields);
			return value.map((row, index) => {
				if (!isObject(row)) throw new ApiError(400, `${path}[${index}] must be an object`);
				return clean(row, rowSpec, `${path}[${index}]`);
			});
		}
		case "object": {
			if (value !== undefined && value !== null && !isObject(value))
				throw new ApiError(400, `${path} must be an object`);
			const source = isObject(value) ? value : {};
			return Object.fromEntries(
				Object.entries(spec.fields).map(([key, child]) => [
					key,
					clean(source[key], child, `${path}.${key}`),
				]),
			);
		}
	}
};

/** Validates one section and returns it with every field present. */
export const sanitizeSection = (key: CppSectionKey, data: unknown): Json =>
	clean(data, SPECS[key], `sections.${key}`) as Json;

export const defaultSectionData = (key: CppSectionKey) => sanitizeSection(key, {});

export type CppSection = { key: CppSectionKey; label: string; data: Json };
type SectionMap = Partial<Record<CppSectionKey, Json>>;

/** Request body → validated map. Sections not sent are simply absent. */
export const parseIncomingSections = (value: unknown): SectionMap => {
	if (!Array.isArray(value))
		throw new ApiError(400, "sections must be a list of { key, data }");
	const out: SectionMap = {};
	for (const entry of value) {
		if (!isObject(entry)) throw new ApiError(400, "Every section must be an object");
		const key = entry.key as CppSectionKey;
		if (!(CPP_SECTION_KEYS as readonly string[]).includes(key))
			throw new ApiError(400, `Unknown section "${String(entry.key)}"`);
		if (out[key]) throw new ApiError(400, `Section "${key}" was sent twice`);
		out[key] = sanitizeSection(key, entry.data);
	}
	return out;
};

/** What is stored in the JSON column → a map by key (ignores anything malformed). */
export const readStoredSections = (stored: unknown): SectionMap => {
	const out: SectionMap = {};
	if (!Array.isArray(stored)) return out;
	for (const entry of stored) {
		if (
			isObject(entry) &&
			(CPP_SECTION_KEYS as readonly string[]).includes(entry.key as string) &&
			isObject(entry.data)
		)
			out[entry.key as CppSectionKey] = entry.data;
	}
	return out;
};

/**
 * Map → the array that is stored and returned (canonical order, labels from here).
 * Requests saved before a section existed (e.g. "financial") get it with defaults.
 */
export const toSectionList = (map: SectionMap): CppSection[] =>
	CPP_SECTION_KEYS.map((key) => ({
		key,
		label: CPP_SECTION_LABELS[key],
		data: map[key] ?? defaultSectionData(key),
	}));

/* ===== section readers ===== */
// The handful of values the submit check, the SAP export, the mail and the PDF read
// out of the stored sections. Previously each of those files had its own copy.

/** One stored section's data, {} when absent. */
export const sectionDataOf = (sections: unknown, key: CppSectionKey): Json =>
	readStoredSections(sections)[key] ?? {};

/** Purchasing → suppliers.recommended (name + vendor code). */
export const recommendedSupplierOf = (sections: unknown): { name: string; code: string } => {
	const recommended = asObject(asObject(sectionDataOf(sections, "purchasing").suppliers).recommended);
	return { name: str(recommended.name), code: str(recommended.code) };
};

export type MasterPlant = { code: string; purchasingGroup: string; taxCode: string };

/** Master Data → plantDetails rows (what the SAP text files need per plant). */
export const masterPlantsOf = (sections: unknown): MasterPlant[] => {
	const rows = sectionDataOf(sections, "master").plantDetails;
	return (Array.isArray(rows) ? rows : []).map((p) => {
		const r = asObject(p);
		return { code: str(r.code), purchasingGroup: str(r.purchasingGroup), taxCode: str(r.taxCode) };
	});
};

/** Ranges picked in Purchasing details, "" when not picked (older requests route on numbers). */
export const approvalBandsOf = (sections: unknown): { partBand: string; amountBand: string } => {
	const values = asObject(sectionDataOf(sections, "purchasing").approvalValues);
	return { partBand: str(values.partBand), amountBand: str(values.amountBand) };
};

/* ===== reference number ===== */

/**
 * "WS" + ddMMyyHHmmss + milliseconds (IST), e.g. WS191126154912347.
 * Same approach as generateVendorOnboardingReferenceNumber: no DB sequence.
 * Uniqueness comes from the timestamp plus the @unique constraint on
 * CppRequest.referenceNumber. A same-millisecond clash fails loudly with P2002
 * instead of creating a duplicate.
 */
const CPP_REFERENCE_TIMEZONE = "Asia/Kolkata";

const getCppReferenceDateParts = (date: Date): Record<string, string> => {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: CPP_REFERENCE_TIMEZONE,
		day: "2-digit",
		month: "2-digit",
		year: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	return Object.fromEntries(parts.map((p) => [p.type, p.value]));
};

export function generateCppReferenceNumber(): string {
	const now = new Date();
	const { day, month, year, hour, minute, second } = getCppReferenceDateParts(now);
	const ms = String(now.getMilliseconds()).padStart(3, "0");
	return `WS${day}${month}${year}${hour}${minute}${second}${ms}`;
}

/** The SAP "source" field is the number only: WS5792955058 -> 5792955058. */
export const sapReferenceOf = (referenceNumber: string): string =>
	referenceNumber.replace(/^WS/i, "");

/* ===== payload ===== */
// Save payload (POST /cpp, PUT /cpp/:id):
//   { category?, plant?, condition?, sections?: [{ key, label?, data }] }
// Only what is sent changes: a missing key is untouched, a section sent again
// replaces that whole section. Listing / routing columns are DERIVED here from
// the sections, never taken from the client.

/** undefined -> untouched; null / "" -> clear. */
const parseOneOf = <T extends readonly string[]>(
	value: unknown,
	field: string,
	allowed: T,
): T[number] | null => {
	if (value === null || value === "") return null;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
		throw new ApiError(400, `${field} must be one of: ${allowed.join(", ")}`);
	return value as T[number];
};

/** Plain decimal string for a Prisma Decimal column, or null. */
export const parseDecimal = (value: unknown, field: string): string | null => {
	if (value === null || value === undefined || value === "") return null;
	const raw =
		typeof value === "number" ? String(value) : String(value).replace(/[,\s₹]/g, "");
	if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new ApiError(400, `${field} must be a number`);
	if (Math.abs(Number(raw)) > 99_999_999_999_999) throw new ApiError(400, `${field} is too large`);
	return raw;
};

/** Values already stored, needed so an update can merge instead of overwrite. */
export type CppStoredRequest = {
	category: string | null;
	plant: string | null;
	condition: string | null;
	sections: unknown;
};

const strOrNull = (value: unknown): string | null => str(value) || null;

/**
 * Turns a request body into Prisma data. Drafts are deliberately lenient:
 * nothing is required here — required-field checks belong to submit.
 */
export function buildCppData(
	bodyInput: unknown,
	stored?: CppStoredRequest,
): Prisma.CppRequestUncheckedUpdateManyInput {
	if (!isObject(bodyInput)) throw new ApiError(400, "Request body must be a JSON object");
	const body = bodyInput;
	const data: Prisma.CppRequestUncheckedUpdateManyInput = {};

	if (has(body, "category")) data.category = parseOneOf(body.category, "category", CPP_CATEGORIES);
	if (has(body, "plant")) data.plant = parseOneOf(body.plant, "plant", CPP_PLANTS);
	if (has(body, "condition"))
		data.condition = parseOneOf(body.condition, "condition", CPP_CONDITION_CODES);

	/* routing combination — checked against what the row WILL contain */
	const category = (has(body, "category") ? data.category : stored?.category) as string | null;
	const plant = (has(body, "plant") ? data.plant : stored?.plant) as string | null;
	const condition = (has(body, "condition") ? data.condition : stored?.condition) as string | null;
	assertValidCombination({ category, plant, condition });

	/* sections — merged by key so one tab never wipes another */
	const sections = readStoredSections(stored?.sections);
	const incoming = has(body, "sections") ? parseIncomingSections(body.sections) : {};
	for (const key of Object.keys(incoming) as CppSectionKey[]) sections[key] = incoming[key];
	const sectionsTouched = Object.keys(incoming).length > 0;
	if (sectionsTouched) data.sections = toSectionList(sections) as unknown as Prisma.InputJsonValue;

	/* derived columns (search + routing) */
	if (sectionsTouched) {
		const basic = sections.basic ?? {};
		const recommended = asObject(asObject((sections.purchasing ?? {}).suppliers).recommended);
		data.reasonCode = strOrNull(basic.reason);
		data.supplierName = strOrNull(recommended.name);
		data.supplierCode = strOrNull(recommended.code);
	}
	if (has(body, "category") || has(body, "plant"))
		data.isSpare = category === "SPARES" || plant === "Spares";
	if (sectionsTouched || has(body, "condition")) {
		const values = asObject((sections.purchasing ?? {}).approvalValues) as Record<
			string,
			string | null
		>;
		// The financial table wins over a typed amount, so the band always
		// matches the financial impact the approvers see.
		const fromTable = financialAmount(condition, sections.financial);
		Object.assign(
			data,
			deriveBandColumns(condition, fromTable === null ? values : { ...values, amount: fromTable }),
		);
	}
	return data;
}

/** Category / plant / condition must be a combination that exists in the workbook. */
export function assertValidCombination(input: {
	category: string | null;
	plant: string | null;
	condition: string | null;
}): void {
	const { category, plant, condition } = input;
	// Early drafts are partial: only check once category and condition are both set.
	if (!category || !condition) return;
	// Plant may still be empty; a neutral plant tests the category/condition pair.
	const result = resolveCombination({ category, plant: plant ?? "KGP", condition });
	if (result.ok === false) throw new ApiError(400, result.reason);
}

/**
 * The approval amount = |Total| of the financial column the condition reads
 * (actual impact for ACTUAL_IMPACT, otherwise the annualised column). Negative
 * totals are price decreases; bands are absolute (Q5). null = the table has no
 * value in that column (old requests fall back to approvalValues.amount).
 */
export function financialAmount(condition: string | null, financial: unknown): string | null {
	const def = condition ? getConditionDef(condition) : undefined;
	if (!def || !isObject(financial) || !isObject(financial.plants)) return null;
	const key = def.amountBasis === "ACTUAL_IMPACT" ? "actualInr" : "annualisedInr";
	let found = false;
	let sum = 0;
	for (const plant of CPP_FINANCIAL_PLANTS) {
		const row = (financial.plants as Json)[plant];
		if (!isObject(row)) continue;
		const raw = row[key];
		if (typeof raw !== "string" || raw === "") continue;
		const n = Number(raw);
		if (!Number.isFinite(n)) continue;
		found = true;
		sum += n;
	}
	if (!found) return null;
	return String(Math.abs(Math.round(sum * 100) / 100));
}

/** Only the column the condition's bands read is filled; the rest are cleared. */
export function deriveBandColumns(
	condition: string | null,
	values: Record<string, string | null | undefined>,
) {
	const def = condition ? getConditionDef(condition) : undefined;
	const out: Record<string, string | null> = {
		maxPartValue: null,
		maxVariationPct: null,
		annualisedValue: null,
		annualisedImpact: null,
		actualImpact: null,
	};
	if (!def) return out;
	const num = (value: string | null | undefined, field: string) => parseDecimal(value ?? null, field);
	if (def.partBasis === "PART_VALUE") out.maxPartValue = num(values.partValue, "approvalValues.partValue");
	if (def.partBasis === "VARIATION_PCT")
		out.maxVariationPct = num(values.variationPct, "approvalValues.variationPct");
	const amount = num(values.amount, "approvalValues.amount");
	if (def.amountBasis === "ANNUALISED_VALUE") out.annualisedValue = amount;
	if (def.amountBasis === "ANNUALISED_IMPACT") out.annualisedImpact = amount;
	if (def.amountBasis === "ACTUAL_IMPACT") out.actualImpact = amount;
	return out;
}

/* ===== submit checks ===== */
// Pure halves of the submit / resubmit / preview checks. The service loads the row
// and the stored summary-sheet rows and hands them in.

/** The request columns the checks read (Prisma Decimal, number, string or null). */
export type CppRoutingRow = {
	category: string | null;
	plant: string | null;
	condition: string | null;
	sections: unknown;
	maxPartValue: unknown;
	maxVariationPct: unknown;
	annualisedValue: unknown;
	annualisedImpact: unknown;
	actualImpact: unknown;
};

const ROUTING = "It decides the approval workflow.";

const AMOUNT_LABEL = {
	ANNUALISED_VALUE: "annualised value",
	ANNUALISED_IMPACT: "annualised impact",
	ACTUAL_IMPACT: "actual impact",
} as const;

/** Works for Prisma Decimal, number, string or null. */
const positive = (value: unknown): boolean => {
	if (value === null || value === undefined || value === "") return false;
	const n = Number(String(value));
	return Number.isFinite(n) && n > 0;
};

/** What must be filled before a request can enter approval. */
export function completenessProblems(request: CppRoutingRow): string[] {
	const problems: string[] = [];
	if (!request.category) problems.push(`Category is required. ${ROUTING}`);
	if (!request.plant) problems.push(`Plant is required. ${ROUTING}`);
	if (!request.condition) problems.push(`Condition is required. ${ROUTING}`);

	const basic = sectionDataOf(request.sections, "basic");
	if (!str(basic.reason)) problems.push("Reason is required.");
	if (!str(basic.justification)) problems.push("Justification is required.");

	const recommended = recommendedSupplierOf(request.sections);
	if (!recommended.name) problems.push("The recommended supplier name is required.");
	// The SAP text files (ZINFOUPDATE_ME11 / ZCHANGEINFO) print it as the Vendor Code.
	if (!recommended.code) problems.push("The recommended supplier's vendor code is required.");

	// Band values: the picked range, or (older requests) the derived number columns.
	const def = request.condition ? getConditionDef(request.condition) : undefined;
	if (def) {
		const bands = approvalBandsOf(request.sections);
		if (def.partBasis === "PART_VALUE" && !bands.partBand && !positive(request.maxPartValue))
			problems.push(`Select the highest value per part range on Purchasing details. ${ROUTING}`);
		if (def.partBasis === "VARIATION_PCT" && !bands.partBand && !positive(request.maxVariationPct))
			problems.push(`Select the highest price variation % range on Purchasing details. ${ROUTING}`);
		const amount =
			def.amountBasis === "ANNUALISED_VALUE"
				? request.annualisedValue
				: def.amountBasis === "ANNUALISED_IMPACT"
					? request.annualisedImpact
					: request.actualImpact;
		if (!bands.amountBand && !positive(amount))
			problems.push(
				`Select the ${AMOUNT_LABEL[def.amountBasis]} range on Purchasing details. ${ROUTING}`,
			);
	}
	return problems;
}

/**
 * Every plant on the uploaded summary sheet must have a Master Data row with a
 * purchasing group and a tax code, or the TCS text files cannot be exported.
 * Checked at submit so the proposer finds out now, not after approval.
 */
export function summaryPlantProblems(rows: PartSummaryRow[], sections: unknown): string[] {
	if (rows.length === 0) return ["Upload the summary sheet (part info) before submitting."];

	const plants = masterPlantsOf(sections);
	const unknownNames = new Set<string>();
	const notSelected = new Set<string>();
	const incomplete = new Set<string>();

	for (const r of rows) {
		const raw = String(r.plant ?? "").trim();
		const code = plantCodeOf(raw);
		if (!code) {
			unknownNames.add(raw || "(blank)");
			continue;
		}
		const plant = plants.find((p) => p.code === code);
		if (!plant) notSelected.add(`${raw} (${code})`);
		else if (!plant.purchasingGroup || !plant.taxCode) incomplete.add(`${raw} (${code})`);
	}

	const problems: string[] = [];
	if (unknownNames.size)
		problems.push(
			`The summary sheet has plant(s) that are not known SAP plants: ${[...unknownNames].join(", ")}.`,
		);
	if (notSelected.size)
		problems.push(
			`Plant(s) ${[...notSelected].join(", ")} are on the summary sheet but not selected as applicable in Master Data.`,
		);
	if (incomplete.size)
		problems.push(
			`Master Data needs a purchasing group and tax code for plant(s) ${[...incomplete].join(", ")}.`,
		);
	return problems;
}

/* ===== responses ===== */

type RequestRow = Prisma.CppRequestGetPayload<{ include: { attachments: true } }>;
type ListRow = Prisma.CppRequestGetPayload<Record<string, never>>;

export const toCppListItem = (row: ListRow) => ({
	id: row.id,
	referenceNumber: row.referenceNumber,
	status: row.status,
	category: row.category,
	plant: row.plant,
	condition: row.condition,
	isSpare: row.isSpare,
	reasonCode: row.reasonCode,
	supplierCode: row.supplierCode,
	supplierName: row.supplierName,
	maxPartValue: row.maxPartValue,
	maxVariationPct: row.maxVariationPct,
	annualisedValue: row.annualisedValue,
	annualisedImpact: row.annualisedImpact,
	actualImpact: row.actualImpact,
	submittedAt: row.submittedAt,
	created_at: row.created_at,
	updated_at: row.updated_at,
	/** The proposer: the frontend permission check compares it with the signed-in user. */
	initiatedById: row.initiatedById,
});

export type CppAttachmentWithUrl = RequestRow["attachments"][number] & { url: string | null };

export const toCppAttachment = (a: CppAttachmentWithUrl) => ({
	id: a.id,
	type: a.type,
	fileName: a.fileName,
	uploadedAt: a.uploadedAt,
	url: a.url ?? undefined,
	// Rows read from the summary sheet at upload; only reported for that slot.
	...(a.type === "partSummary"
		? { partRowCount: readStoredPartSummary((a as { parsedData?: unknown }).parsedData).length }
		: {}),
});

export type CppPerson = { id: string; name: string | null; email: string | null };

export const toCppDetail = (
	row: RequestRow,
	attachments: CppAttachmentWithUrl[],
	initiatedBy: CppPerson | null = null,
) => ({
	...toCppListItem(row),
	/** Always every section, in tab order, every field present. */
	sections: toSectionList(readStoredSections(row.sections)),
	attachments: attachments.map(toCppAttachment),
	/** Shown as "Proposed By" on the CPP document. */
	initiatedBy,
	/**
	 * Summary sheet part rows, same keys as PART_SUMMARY_COLUMNS in cpp.sheet.ts.
	 * Used by the CPP document's part table and the part pickers in Purchasing details.
	 */
	parts: readStoredPartSummary(
		(attachments.find((a) => a.type === "partSummary") as { parsedData?: unknown } | undefined)
			?.parsedData,
	),
});

/* ===== pending on ===== */

/**
 * Who a CPP request waits on — same idea as resolveVendorOnboardingPendingOn in
 * workflowSubject.helper.ts, kept here so the CPP module never changes a kernel file.
 *   DRAFT / CLARIFICATION_REQUESTED -> the proposer (submit / edit and resubmit)
 *   COMPLETED                       -> nobody
 *   anything else                   -> what the workflow says (pending approvers)
 */
export function resolveCppPendingOn(
	status: string,
	workflowBasedPendingOn: PendingOn | undefined,
): PendingOn {
	if (status === CPP_STATUS.DRAFT || status === CPP_STATUS.CLARIFICATION_REQUESTED)
		return { role: "PROPOSER" };
	if (status === CPP_STATUS.COMPLETED) return { role: "NONE", outcome: "APPROVED" };
	return workflowBasedPendingOn ?? { role: "PROPOSER" };
}

/* ===== listing ===== */

export type CppListingTab = "myRequests" | "drafts" | "pendingOnMe" | "approvedByMe";

const CPP_LISTING_TABS: readonly CppListingTab[] = [
	"myRequests",
	"drafts",
	"pendingOnMe",
	"approvedByMe",
];

/** The two tabs that list other people's requests because I am an approver on them. */
export const isCppApprovalTab = (tab: CppListingTab): tab is "pendingOnMe" | "approvedByMe" =>
	tab === "pendingOnMe" || tab === "approvedByMe";

export function parseCppListingParams(query: Record<string, unknown>) {
	const pageIndex = Math.max(0, Number.parseInt(String(query.page_index ?? "0"), 10) || 0);
	const requested = Number.parseInt(String(query.page_size ?? CPP_DEFAULT_PAGE_SIZE), 10);
	const pageSize = Math.min(
		CPP_MAX_PAGE_SIZE,
		Number.isFinite(requested) && requested > 0 ? requested : CPP_DEFAULT_PAGE_SIZE,
	);
	const tab: CppListingTab = (CPP_LISTING_TABS as readonly unknown[]).includes(query.tab)
		? (query.tab as CppListingTab)
		: "myRequests";
	return {
		tab,
		pageIndex,
		pageSize,
		search: typeof query.search === "string" ? query.search.trim().slice(0, 100) : "",
		status: typeof query.status === "string" ? query.status : undefined,
	};
}

export function buildCppWhere(
	workspaceId: string,
	userId: string,
	params: ReturnType<typeof parseCppListingParams>,
	/** For the approver tabs: ids of the requests I am an approver on. */
	approvalSubjectIds: string[] = [],
): Prisma.CppRequestWhereInput {
	const approvalTab = isCppApprovalTab(params.tab);
	// Approver tabs show other people's requests; my own tabs show only mine.
	const where: Prisma.CppRequestWhereInput = approvalTab
		? { workspaceId, id: { in: approvalSubjectIds } }
		: { workspaceId, initiatedById: userId };

	if (approvalTab) {
		// A draft has no workflow, so it can never appear here; nothing else to filter.
	} else if (params.tab === "drafts") where.status = CPP_STATUS.DRAFT;
	else {
		// "My requests" = everything I have actually submitted.
		where.status =
			params.status &&
			params.status !== "all" &&
			params.status !== CPP_STATUS.DRAFT &&
			isCppStatus(params.status)
				? params.status
				: { not: CPP_STATUS.DRAFT };
	}

	if (params.search) {
		const contains = { contains: params.search, mode: "insensitive" as const };
		where.OR = [
			{ referenceNumber: contains },
			{ supplierName: contains },
			{ supplierCode: contains },
		];
	}
	return where;
}

export function resolveCppOrderBy(
	sortBy: unknown,
	sortOrder: unknown,
): Prisma.CppRequestOrderByWithRelationInput {
	const field = (CPP_LISTING_SORT_FIELDS as readonly string[]).includes(String(sortBy))
		? String(sortBy)
		: "updated_at";
	return { [field]: sortOrder === "asc" ? "asc" : "desc" };
}

/* ===== files ===== */

/** Safe for S3 keys and download file names. */
export const safeFileName = (name: string): string =>
	name
		.replace(/[^\w.\-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(-120) || "file";

export const fileExtension = (name: string): string =>
	name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";

/* ===== matrix ===== */
// Pure logic behind the admin approval-matrix screen: coverage check,
// "does this save make things worse", and "replace user everywhere".

/** slotKey(roleKey, scope) -> user ids in that slot. */
export type SlotMap = Map<string, string[]>;

export type CoverageIssue = {
	roleKey: string;
	scope: string;
	severity: "error" | "warning";
	message: string;
};

const COMMITTEE_KEYS = [1, 2, 3, 4, 5, 6, 7].map((n) => `COMMITTEE_${n}`);
const COMMITTEE_MIN = 3;

/**
 * An empty slot that a workflow needs is an ERROR: the request would have nobody
 * to go to. Committee: at least 3 of 7 must be filled (3 approvals are required).
 * An empty TCS role is only a WARNING: approvals still run, the mail is skipped.
 */
export function computeCoverage(slots: SlotMap): CoverageIssue[] {
	const usage = roleUsage();
	const issues: CoverageIssue[] = [];
	const filled = (roleKey: string, scope: string) =>
		(slots.get(slotKey(roleKey, scope)) ?? []).length > 0;

	for (const role of ASSIGNABLE_ROLES) {
		if (role.observer || role.recipient || COMMITTEE_KEYS.includes(role.key)) continue;
		const used = usage.get(role.key) ?? 0;
		if (used === 0) continue;
		for (const scope of scopesForRole(role)) {
			if (filled(role.key, scope)) continue;
			issues.push({
				roleKey: role.key,
				scope,
				severity: "error",
				message:
					scope === "ALL"
						? `${role.label} has nobody assigned (used by ${used} workflow bands).`
						: `${role.label} has nobody assigned for ${scope} (used by ${used} workflow bands).`,
			});
		}
	}

	const filledCommittee = COMMITTEE_KEYS.filter((key) => filled(key, "ALL")).length;
	if (filledCommittee < COMMITTEE_MIN)
		issues.push({
			roleKey: "COMMITTEE_1",
			scope: "ALL",
			severity: "error",
			message: `The CPP committee needs at least ${COMMITTEE_MIN} members (3 approvals are required); ${filledCommittee} assigned.`,
		});
	else if (filledCommittee < COMMITTEE_KEYS.length)
		issues.push({
			roleKey: "COMMITTEE_1",
			scope: "ALL",
			severity: "warning",
			message: `${filledCommittee} of 7 committee seats are filled.`,
		});

	if (!filled(CPP_TCS_ROLE_KEY, "ALL"))
		issues.push({
			roleKey: CPP_TCS_ROLE_KEY,
			scope: "ALL",
			severity: "warning",
			message: "Nobody is assigned to TCS, so no mail is sent when a CPP request is approved.",
		});
	return issues;
}

const issueId = (issue: CoverageIssue) => `${issue.roleKey}:${issue.scope}:${issue.severity}`;

/** Errors that exist after a change but not before it — those block the save. */
export function newCoverageErrors(before: SlotMap, after: SlotMap): CoverageIssue[] {
	const existing = new Set(
		computeCoverage(before)
			.filter((i) => i.severity === "error")
			.map(issueId),
	);
	return computeCoverage(after).filter((i) => i.severity === "error" && !existing.has(issueId(i)));
}

export type SlotUpdate = { roleKey: string; scope: string; userIds: string[] };

/** Validates the request body of PUT /approval-matrix. Throws plain Errors with a message. */
export function parseSlotUpdates(value: unknown): SlotUpdate[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error("assignments must be a non-empty list");
	if (value.length > 200) throw new Error("Too many assignments in one save");
	const seen = new Set<string>();
	return value.map((entry, index) => {
		const item = entry as Partial<SlotUpdate> | null;
		if (!item || typeof item !== "object") throw new Error(`assignments[${index}] must be an object`);
		const { roleKey, scope, userIds } = item;
		if (typeof roleKey !== "string" || typeof scope !== "string" || !isValidSlot(roleKey, scope))
			throw new Error(`assignments[${index}] is not a valid role / scope`);
		if (!(CPP_SLOT_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope ${scope}`);
		if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== "string" || !id))
			throw new Error(`assignments[${index}].userIds must be a list of user ids`);
		if (userIds.length > 50) throw new Error(`${getRole(roleKey)?.label ?? roleKey} has too many people`);
		const key = slotKey(roleKey, scope);
		if (seen.has(key)) throw new Error(`Slot ${key} was sent twice`);
		seen.add(key);
		return { roleKey, scope, userIds: [...new Set(userIds)] };
	});
}

export type AssignmentRow = { id: string; roleKey: string; scope: string; userId: string };

/**
 * "Replace user everywhere": rows held by `fromUserId` move to `toUserId`.
 * Where `toUserId` already sits in the same slot the old row is deleted instead
 * (the unique key would otherwise be violated).
 */
export function planReplaceUser(rows: AssignmentRow[], fromUserId: string, toUserId: string) {
	const toSlots = new Set(
		rows.filter((r) => r.userId === toUserId).map((r) => slotKey(r.roleKey, r.scope)),
	);
	const updates: string[] = [];
	const deletes: string[] = [];
	for (const row of rows.filter((r) => r.userId === fromUserId))
		(toSlots.has(slotKey(row.roleKey, row.scope)) ? deletes : updates).push(row.id);
	return { updates, deletes };
}

export const rowsToSlotMap = (
	rows: Array<{ roleKey: string; scope: string; userId: string; position?: number }>,
): SlotMap => {
	const map: SlotMap = new Map();
	[...rows]
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
		.forEach((row) => {
			const key = slotKey(row.roleKey, row.scope);
			map.set(key, [...(map.get(key) ?? []), row.userId]);
		});
	return map;
};

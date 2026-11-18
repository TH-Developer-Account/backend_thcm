import ApiError from "@shared/utils/apiError";

import {
	ASSIGNABLE_ROLES,
	CPP_APPLICABLE_PLANTS,
	CPP_DEFAULT_PAGE_SIZE,
	CPP_EFFECTS,
	CPP_LISTING_SORT_FIELDS,
	CPP_MAX_PAGE_SIZE,
	CPP_PRICE_TYPES,
	CPP_SLOT_SCOPES,
	CPP_STATUS,
	getRole,
	isCppStatus,
	isValidSlot,
	scopesForRole,
	slotKey,
} from "./cpp.constants";
import { type Prisma } from "../../prisma/generated/prisma/client";
import {
	CPP_CATEGORIES,
	CPP_CONDITION_CODES,
	CPP_PLANTS,
	getConditionDef,
	resolveCombination,
	roleUsage,
} from "./cpp.rules";

/* ===== sections ===== */
// cpp.sections.ts — a CPP request is saved as an array of sections, one per
// wizard tab:   [{ key: "basic", label: "Basic details", data: { … } }, …]
// Same idea as the attachments list (label + data). The server owns the shape:
// unknown keys are dropped, types and lengths are checked, and an empty section
// always comes back with every field present, so the UI never meets `undefined`.
// Files are NOT part of the sections — they are separate uploads (cpp_attachment).

export const CPP_SECTION_KEYS = [
	"basic",
	"purchasing",
	"master",
	"other",
] as const;
export type CppSectionKey = (typeof CPP_SECTION_KEYS)[number];

export const CPP_SECTION_LABELS: Record<CppSectionKey, string> = {
	basic: "Basic details",
	purchasing: "Purchasing details",
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
	| { t: "object"; fields: Record<string, Spec> };

const text = (max: number): Spec => ({ t: "text", max });
const obj = (fields: Record<string, Spec>): Spec => ({ t: "object", fields });

const supplier = obj({
	partnerId: text(60),
	name: text(200),
	code: text(40),
	manual: { t: "bool" },
});

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
		suppliers: obj({
			existing: supplier,
			other: supplier,
			recommended: supplier,
		}),
		approvalValues: obj({
			partValue: { t: "decimal" },
			variationPct: { t: "decimal" },
			amount: { t: "decimal" },
		}),
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
	}),
	other: obj({ remarks: text(2000) }),
};

const clean = (value: unknown, spec: Spec, path: string): unknown => {
	switch (spec.t) {
		case "text": {
			if (value === undefined || value === null) return "";
			if (typeof value !== "string")
				throw new ApiError(400, `${path} must be text`);
			const out = value.trim();
			if (out.length > spec.max)
				throw new ApiError(
					400,
					`${path} is too long (max ${spec.max} characters)`,
				);
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
			const raw = String(value).replace(/[,\s₹]/g, "");
			if (!/^-?\d+(\.\d+)?$/.test(raw))
				throw new ApiError(400, `${path} must be a number`);
			if (Math.abs(Number(raw)) > 99_999_999_999_999)
				throw new ApiError(400, `${path} is too large`);
			return raw;
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
			if (!Array.isArray(value))
				throw new ApiError(400, `${path} must be a list`);
			if (value.length > spec.max)
				throw new ApiError(
					400,
					`${path} has too many entries (max ${spec.max})`,
				);
			const items = value.map((item) => {
				if (
					typeof item !== "string" ||
					item.trim() === "" ||
					item.length > spec.item
				)
					throw new ApiError(400, `${path} contains an invalid value`);
				if (spec.allowed && !spec.allowed.includes(item))
					throw new ApiError(400, `${path} has an invalid value "${item}"`);
				return item.trim();
			});
			return [...new Set(items)];
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
export const sanitizeSection = (
	key: CppSectionKey,
	data: unknown,
): Record<string, unknown> =>
	clean(data, SPECS[key], `sections.${key}`) as Record<string, unknown>;

export const defaultSectionData = (key: CppSectionKey) =>
	sanitizeSection(key, {});

export type CppSection = {
	key: CppSectionKey;
	label: string;
	data: Record<string, unknown>;
};

/** Request body → validated map. Sections not sent are simply absent. */
export const parseIncomingSections = (
	value: unknown,
): Partial<Record<CppSectionKey, Record<string, unknown>>> => {
	if (!Array.isArray(value))
		throw new ApiError(400, "sections must be a list of { key, data }");
	const out: Partial<Record<CppSectionKey, Record<string, unknown>>> = {};
	for (const entry of value) {
		if (!isObject(entry))
			throw new ApiError(400, "Every section must be an object");
		const key = entry.key as CppSectionKey;
		if (!(CPP_SECTION_KEYS as readonly string[]).includes(key))
			throw new ApiError(400, `Unknown section "${String(entry.key)}"`);
		if (out[key]) throw new ApiError(400, `Section "${key}" was sent twice`);
		out[key] = sanitizeSection(key, entry.data);
	}
	return out;
};

/** What is stored in the JSON column → a map by key (ignores anything malformed). */
export const readStoredSections = (
	stored: unknown,
): Partial<Record<CppSectionKey, Record<string, unknown>>> => {
	const out: Partial<Record<CppSectionKey, Record<string, unknown>>> = {};
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

/** Map → the array that is stored and returned (canonical order, labels from here). */
export const toSectionList = (
	map: Partial<Record<CppSectionKey, Record<string, unknown>>>,
): CppSection[] =>
	CPP_SECTION_KEYS.map((key) => ({
		key,
		label: CPP_SECTION_LABELS[key],
		data: map[key] ?? defaultSectionData(key),
	}));

/* ===== helper ===== */
// cpp.helper.ts — payload parsing, reference numbers, response mapping, listing.
// No req/res in here, so it can be unit tested on its own.
//
// Save payload (POST /cpp, PUT /cpp/:id):
//   {
//     category?, plant?, condition?,             // routing — real columns
//     sections?: [{ key, label?, data }]         // one per tab, see cpp.sections.ts
//   }
// Only what is sent changes: a missing key is untouched, a section sent again
// replaces that whole section. Listing / routing columns are DERIVED here from
// the sections, never taken from the client.

type Json = Record<string, unknown>;

/* ---------------------------- reference number ---------------------------- */

// Format: WS-<timestamp>, e.g. WS-20261118102705123 (UTC, down to the millisecond).
// Same approach as generateMedicalClaimReferenceNumber; the column is a plain unique string.
export function generateCppReferenceNumber(): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:T.Z]/g, "")
		.slice(0, 17);

	return `WS-${timestamp}`;
}

/* ------------------------------ small parsers ----------------------------- */

const has = (obj: Json, key: string) =>
	Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** undefined -> untouched; null / "" -> clear. */
const parseOneOf = <T extends readonly string[]>(
	value: unknown,
	field: string,
	allowed: T,
): T[number] | null => {
	if (value === null || value === "") return null;
	if (
		typeof value !== "string" ||
		!(allowed as readonly string[]).includes(value)
	)
		throw new ApiError(400, `${field} must be one of: ${allowed.join(", ")}`);
	return value as T[number];
};

/** Plain decimal string for a Prisma Decimal column, or null. */
export const parseDecimal = (value: unknown, field: string): string | null => {
	if (value === null || value === undefined || value === "") return null;
	const raw =
		typeof value === "number"
			? String(value)
			: String(value).replace(/[,\s₹]/g, "");
	if (!/^-?\d+(\.\d+)?$/.test(raw))
		throw new ApiError(400, `${field} must be a number`);
	if (Math.abs(Number(raw)) > 99_999_999_999_999)
		throw new ApiError(400, `${field} is too large`);
	return raw;
};

/* --------------------------------- payload -------------------------------- */

/** Values already stored, needed so an update can merge instead of overwrite. */
export type CppStoredRequest = {
	category: string | null;
	plant: string | null;
	condition: string | null;
	sections: unknown;
};

const str = (value: unknown): string | null => {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? null : text;
};

/**
 * Turns a request body into Prisma data. Drafts are deliberately lenient:
 * nothing is required here — required-field checks belong to submit.
 */
export function buildCppData(
	bodyInput: unknown,
	stored?: CppStoredRequest,
): Prisma.CppRequestUncheckedUpdateManyInput {
	if (!isObject(bodyInput))
		throw new ApiError(400, "Request body must be a JSON object");
	const body = bodyInput;
	const data: Prisma.CppRequestUncheckedUpdateManyInput = {};

	if (has(body, "category"))
		data.category = parseOneOf(body.category, "category", CPP_CATEGORIES);
	if (has(body, "plant"))
		data.plant = parseOneOf(body.plant, "plant", CPP_PLANTS);
	if (has(body, "condition"))
		data.condition = parseOneOf(
			body.condition,
			"condition",
			CPP_CONDITION_CODES,
		);

	/* routing combination — checked against what the row WILL contain */
	const category = (
		has(body, "category") ? data.category : stored?.category
	) as string | null;
	const plant = (has(body, "plant") ? data.plant : stored?.plant) as
		| string
		| null;
	const condition = (
		has(body, "condition") ? data.condition : stored?.condition
	) as string | null;
	assertValidCombination({ category, plant, condition });

	/* sections — merged by key so one tab never wipes another */
	const sections = readStoredSections(stored?.sections);
	const incoming = has(body, "sections")
		? parseIncomingSections(body.sections)
		: {};
	for (const key of Object.keys(incoming) as CppSectionKey[])
		sections[key] = incoming[key];
	const sectionsTouched = Object.keys(incoming).length > 0;
	if (sectionsTouched)
		data.sections = toSectionList(sections) as unknown as Prisma.InputJsonValue;

	/* derived columns (search + routing) */
	if (sectionsTouched) {
		const basic = sections.basic ?? {};
		const suppliers = isObject((sections.purchasing ?? {}).suppliers)
			? ((sections.purchasing as Json).suppliers as Json)
			: {};
		const recommended = isObject(suppliers.recommended)
			? suppliers.recommended
			: {};
		data.reasonCode = str(basic.reason);
		data.supplierName = str(recommended.name);
		data.supplierCode = str(recommended.code);
	}
	if (has(body, "category") || has(body, "plant"))
		data.isSpare = category === "SPARES" || plant === "Spares";
	if (sectionsTouched || has(body, "condition")) {
		const purchasing = sections.purchasing ?? {};
		const values = isObject(purchasing.approvalValues)
			? (purchasing.approvalValues as Record<string, string | null>)
			: {};
		Object.assign(data, deriveBandColumns(condition, values));
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
	const result = resolveCombination({
		category,
		plant: plant ?? "KGP",
		condition,
	});
	if (!result.ok)
		throw new ApiError(400, (result as { reason: string }).reason);
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
	const num = (value: string | null | undefined, field: string) =>
		parseDecimal(value ?? null, field);
	if (def.partBasis === "PART_VALUE")
		out.maxPartValue = num(values.partValue, "approvalValues.partValue");
	if (def.partBasis === "VARIATION_PCT")
		out.maxVariationPct = num(
			values.variationPct,
			"approvalValues.variationPct",
		);
	const amount = num(values.amount, "approvalValues.amount");
	if (def.amountBasis === "ANNUALISED_VALUE") out.annualisedValue = amount;
	if (def.amountBasis === "ANNUALISED_IMPACT") out.annualisedImpact = amount;
	if (def.amountBasis === "ACTUAL_IMPACT") out.actualImpact = amount;
	return out;
}

/* -------------------------------- responses ------------------------------- */

type RequestRow = Prisma.CppRequestGetPayload<{
	include: { attachments: true };
}>;
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
});

export type CppAttachmentWithUrl = RequestRow["attachments"][number] & {
	url: string | null;
};

export const toCppAttachment = (a: CppAttachmentWithUrl) => ({
	id: a.id,
	type: a.type,
	fileName: a.fileName,
	uploadedAt: a.uploadedAt,
	url: a.url ?? undefined,
});

export const toCppDetail = (
	row: RequestRow,
	attachments: CppAttachmentWithUrl[],
) => ({
	...toCppListItem(row),
	/** Always all four sections, in tab order, every field present. */
	sections: toSectionList(readStoredSections(row.sections)),
	attachments: attachments.map(toCppAttachment),
});

/* --------------------------------- listing -------------------------------- */

export type CppListingTab = "myRequests" | "drafts";

export function parseCppListingParams(query: Record<string, unknown>) {
	const pageIndex = Math.max(
		0,
		Number.parseInt(String(query.page_index ?? "0"), 10) || 0,
	);
	const requested = Number.parseInt(
		String(query.page_size ?? CPP_DEFAULT_PAGE_SIZE),
		10,
	);
	const pageSize = Math.min(
		CPP_MAX_PAGE_SIZE,
		Number.isFinite(requested) && requested > 0
			? requested
			: CPP_DEFAULT_PAGE_SIZE,
	);
	const tab: CppListingTab = query.tab === "drafts" ? "drafts" : "myRequests";
	return {
		tab,
		pageIndex,
		pageSize,
		search:
			typeof query.search === "string" ? query.search.trim().slice(0, 100) : "",
		status: typeof query.status === "string" ? query.status : undefined,
	};
}

export function buildCppWhere(
	workspaceId: string,
	userId: string,
	params: ReturnType<typeof parseCppListingParams>,
): Prisma.CppRequestWhereInput {
	const where: Prisma.CppRequestWhereInput = {
		workspaceId,
		initiatedById: userId,
	};

	if (params.tab === "drafts") where.status = CPP_STATUS.DRAFT;
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
	const field = (CPP_LISTING_SORT_FIELDS as readonly string[]).includes(
		String(sortBy),
	)
		? String(sortBy)
		: "updated_at";
	return { [field]: sortOrder === "asc" ? "asc" : "desc" };
}

/* ---------------------------------- files --------------------------------- */

export const safeFileName = (name: string): string =>
	name
		.replace(/[^\w.\-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(-120) || "file";

export const fileExtension = (name: string): string =>
	name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";

/* ===== matrix.helper ===== */
// cpp.matrix.helper.ts — pure logic behind the admin approval-matrix screen:
// coverage check, "does this save make things worse", and "replace user everywhere".
// No database in here, so it is unit tested on its own.

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
 */
export function computeCoverage(slots: SlotMap): CoverageIssue[] {
	const usage = roleUsage();
	const issues: CoverageIssue[] = [];
	const filled = (roleKey: string, scope: string) =>
		(slots.get(slotKey(roleKey, scope)) ?? []).length > 0;

	for (const role of ASSIGNABLE_ROLES) {
		if (role.observer || COMMITTEE_KEYS.includes(role.key)) continue;
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

	const filledCommittee = COMMITTEE_KEYS.filter((key) =>
		filled(key, "ALL"),
	).length;
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
	return issues;
}

const issueId = (issue: CoverageIssue) =>
	`${issue.roleKey}:${issue.scope}:${issue.severity}`;

/** Errors that exist after a change but not before it — those block the save. */
export function newCoverageErrors(
	before: SlotMap,
	after: SlotMap,
): CoverageIssue[] {
	const existing = new Set(
		computeCoverage(before)
			.filter((i) => i.severity === "error")
			.map(issueId),
	);
	return computeCoverage(after).filter(
		(i) => i.severity === "error" && !existing.has(issueId(i)),
	);
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
		if (!item || typeof item !== "object")
			throw new Error(`assignments[${index}] must be an object`);
		const { roleKey, scope, userIds } = item;
		if (
			typeof roleKey !== "string" ||
			typeof scope !== "string" ||
			!isValidSlot(roleKey, scope)
		)
			throw new Error(`assignments[${index}] is not a valid role / scope`);
		if (!(CPP_SLOT_SCOPES as readonly string[]).includes(scope))
			throw new Error(`Unknown scope ${scope}`);
		if (
			!Array.isArray(userIds) ||
			userIds.some((id) => typeof id !== "string" || !id)
		)
			throw new Error(
				`assignments[${index}].userIds must be a list of user ids`,
			);
		if (userIds.length > 50)
			throw new Error(
				`${getRole(roleKey)?.label ?? roleKey} has too many people`,
			);
		const key = slotKey(roleKey, scope);
		if (seen.has(key)) throw new Error(`Slot ${key} was sent twice`);
		seen.add(key);
		return { roleKey, scope, userIds: [...new Set(userIds)] };
	});
}

export type AssignmentRow = {
	id: string;
	roleKey: string;
	scope: string;
	userId: string;
};

/**
 * "Replace user everywhere": rows held by `fromUserId` move to `toUserId`.
 * Where `toUserId` already sits in the same slot the old row is deleted instead
 * (the unique key would otherwise be violated).
 */
export function planReplaceUser(
	rows: AssignmentRow[],
	fromUserId: string,
	toUserId: string,
) {
	const toSlots = new Set(
		rows
			.filter((r) => r.userId === toUserId)
			.map((r) => slotKey(r.roleKey, r.scope)),
	);
	const updates: string[] = [];
	const deletes: string[] = [];
	for (const row of rows.filter((r) => r.userId === fromUserId))
		(toSlots.has(slotKey(row.roleKey, row.scope)) ? deletes : updates).push(
			row.id,
		);
	return { updates, deletes };
}

export const rowsToSlotMap = (
	rows: Array<{
		roleKey: string;
		scope: string;
		userId: string;
		position?: number;
	}>,
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

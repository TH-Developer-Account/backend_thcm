// cpp.workflow.ts — the approval plan of a CPP request, and the catalog of reusable
// approval templates. Pure: no DB, no Express. (cpp.template.catalog.ts merged in here.)
//
//   PLAN      a saved request + the approval matrix -> the stage list of ONE workflow
//             (WF1 stages, then WF2 stages, in order)
//     - Band:   the request's values pick exactly one rule (e.g. FTR-M-02). New requests
//               pick RANGES in the form (partBand / amountBand); requests saved before that
//               still route on their typed numbers.
//     - Chain:  that rule's steps name ROLES; the matrix says who sits in each role.
//     - Result: every problem is collected, so the admin can fix them in one go.
//
//   CATALOG   every template CPP can ever need. A request's approval has two parts and each
//             part has its own template:
//               WF1  plant / SCM chain  (Category Head … SCM Head). Differs by category, plant, band.
//               WF2  CPP committee      (committee 3 of 7 → Alt Chairman / Chairman → MD for some bands).
//             Many bands share one shape, so the module needs a few dozen templates, not one per band.
//             The SHAPE comes from the rules in code; the PEOPLE come from the matrix and are filled
//             in by cpp.workflow.service.ts.
import { createHash } from "crypto";

import { getRole, slotKey } from "./cpp.constants";
import { approvalBandsOf, type SlotMap } from "./cpp.helper";
import {
	type Band,
	type CppBlock,
	type CppChainStepRaw,
	type ConditionDef,
	CPP_CATEGORIES,
	CPP_CONDITIONS_DEF,
	CPP_PLANTS,
	getChain,
	getConditionDef,
	resolveCombination,
} from "./cpp.rules";

/* ===================================== PLAN ===================================== */

/** Q13 default: for Import NON HCM, "Head - SCM KGP Plant & Imports" REPLACES Head SCM KGP/DWD. */
const IMPORT_NON_HCM_REPLACES_HEAD_SCM = true;
const HEAD_SCM = "HEAD_SCM";
const HEAD_SCM_IMPORTS = "HEAD_SCM_KGP_PLANT_IMPORTS";

export type Phase = "WF1" | "WF2";

export type PlanStage = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals?: number;
	approverIds: string[];
	/** Which part of the lifecycle this stage belongs to. */
	phase: Phase;
	roleKeys: string[];
	/** The exact matrix seats behind this stage, e.g. "HEAD_SCM:KGP". Identifies the shared template. */
	slots: string[];
};

export type PlanInput = {
	category: string;
	plant: string;
	condition: string;
	/** Decimal strings from the request row (or null). Older requests only. */
	maxPartValue: string | null;
	maxVariationPct: string | null;
	annualisedValue: string | null;
	annualisedImpact: string | null;
	actualImpact: string | null;
	/**
	 * Ranges picked in Purchasing details (frontend utils/cpp.bands.ts), as band
	 * keys: "_10000", "10000_100000", "1000000_20000000", "20000000_".
	 * When amountBand is set these decide the rule and the numbers are ignored.
	 */
	partBand?: string | null;
	amountBand?: string | null;
	slots: SlotMap;
};

export type PlanResult =
	| {
			ok: true;
			ruleId: string;
			bandLabel: string;
			level: string;
			block: CppBlock;
			stages: PlanStage[];
			priceFeedingUserIds: string[];
			/** Roles to inform only (crude oil above 25 L: MD). Not approval stages. */
			reportingUserIds: string[];
			warnings: string[];
	  }
	| { ok: false; problems: string[] };

export type PlanOk = Extract<PlanResult, { ok: true }>;

/** A saved request row + the matrix -> the plan input (Decimals become strings). */
export const planInputOf = (
	request: {
		category: string | null;
		plant: string | null;
		condition: string | null;
		sections: unknown;
		maxPartValue: unknown;
		maxVariationPct: unknown;
		annualisedValue: unknown;
		annualisedImpact: unknown;
		actualImpact: unknown;
	},
	slots: SlotMap,
): PlanInput => {
	const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
	return {
		category: request.category ?? "",
		plant: request.plant ?? "",
		condition: request.condition ?? "",
		maxPartValue: text(request.maxPartValue),
		maxVariationPct: text(request.maxVariationPct),
		annualisedValue: text(request.annualisedValue),
		annualisedImpact: text(request.annualisedImpact),
		actualImpact: text(request.actualImpact),
		// Picked ranges win over the numbers (see pickRule).
		...approvalBandsOf(request.sections),
		slots,
	};
};

/**
 * Range key shared with the frontend dropdowns (utils/cpp.bands.ts):
 * `${gt}_${lte}`, an open side left empty. Both sides build it from the same
 * grid numbers, so a picked option matches exactly one grid cell.
 */
export const bandKey = (band: Band): string => `${band.gt ?? ""}_${band.lte ?? ""}`;

const inBand = (value: number, band: Band): boolean =>
	(band.gt === undefined || value > band.gt) && (band.lte === undefined || value <= band.lte);

const num = (value: string | null): number | null => {
	if (value === null || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

/** Which column the condition's amount bands read. */
const amountOf = (def: ConditionDef, input: PlanInput): number | null =>
	num(
		def.amountBasis === "ANNUALISED_VALUE"
			? input.annualisedValue
			: def.amountBasis === "ANNUALISED_IMPACT"
				? input.annualisedImpact
				: input.actualImpact,
	);

/**
 * Picks the band (rule id). Picked ranges win; otherwise the request's numbers
 * are matched. Upper bound belongs to the lower band (Q6).
 */
export function pickRule(
	input: PlanInput,
	block: CppBlock,
	def: ConditionDef,
): { ruleId: string; label: string; level: string } | { problem: string } {
	const grid = block === "SPARES" && def.spareGrid ? def.spareGrid : def.grid;
	const letter = block === "SPARES" ? "S" : "M";
	const ruleOf = (index: number) => ({
		ruleId: `${def.ruleIdPrefix}-${letter}-${String(index + 1).padStart(2, "0")}`,
		label: grid[index].label,
		level: grid[index].level,
	});

	/* ---- ranges picked in the form ---- */
	const amountBand = input.amountBand?.trim() || "";
	const partBand = input.partBand?.trim() || "";
	if (amountBand) {
		if (def.partBasis && !partBand)
			return {
				problem:
					def.partBasis === "PART_VALUE"
						? "The highest value per part range is missing."
						: "The price variation % range is missing.",
			};
		const index = grid.findIndex(
			(cell) =>
				bandKey(cell.amount) === amountBand && (!cell.part || bandKey(cell.part) === partBand),
		);
		if (index < 0)
			return {
				problem:
					"The selected ranges do not match an approval band for this condition. Pick them again on Purchasing details.",
			};
		return ruleOf(index);
	}

	/* ---- typed numbers (requests saved before the ranges) ---- */
	const amount = amountOf(def, input);
	if (amount === null || amount <= 0)
		return { problem: "The approval amount is missing or zero, so no approval band applies." };

	let part: number | null = null;
	if (def.partBasis === "PART_VALUE") part = num(input.maxPartValue);
	if (def.partBasis === "VARIATION_PCT") {
		const pct = num(input.maxVariationPct);
		part = pct === null ? null : Math.abs(pct);
	}
	if (def.partBasis && part === null)
		return {
			problem:
				def.partBasis === "PART_VALUE"
					? "The highest part value is missing."
					: "The price variation % is missing.",
		};

	const index = grid.findIndex(
		(cell) =>
			inBand(amount, cell.amount) && (!cell.part || (part !== null && inBand(part, cell.part))),
	);
	if (index < 0)
		return { problem: "No approval band matches these values (check the amount and part value)." };

	return ruleOf(index);
}

const usersFor = (slots: SlotMap, roleKey: string, plantSlot: string | null) => {
	const role = getRole(roleKey);
	if (!role) return { users: [] as string[], scope: "ALL", missingPlant: false };
	if (role.scope === "PLANT") {
		if (!plantSlot) return { users: [], scope: "PLANT", missingPlant: true };
		return {
			users: slots.get(slotKey(roleKey, plantSlot)) ?? [],
			scope: plantSlot,
			missingPlant: false,
		};
	}
	return { users: slots.get(slotKey(roleKey, "ALL")) ?? [], scope: "ALL", missingPlant: false };
};

const unique = (ids: string[]) => [...new Set(ids)];

/** Role keys a step really uses for this category (variant swap, DOMP skip, Import NON HCM reroute). */
const effectiveRoles = (
	step: CppChainStepRaw,
	category: string,
	def: ConditionDef,
): string[] | null => {
	if (category === "DOMP" && def.notes.includes("N_DOMP_SKIP") && step.roleKeys.includes(HEAD_SCM))
		return null; // stage removed

	const variant = step.variants?.[category];
	let roles = variant ? [variant] : step.roleKeys;

	if (
		IMPORT_NON_HCM_REPLACES_HEAD_SCM &&
		category === "IMPORT_NON_HCM" &&
		def.notes.includes("N_IMPORT_NON_HCM") &&
		roles.includes(HEAD_SCM)
	)
		roles = roles.map((r) => (r === HEAD_SCM ? HEAD_SCM_IMPORTS : r));
	return roles;
};

export type BuiltStages = {
	stages: PlanStage[];
	/** Roles to inform only (not approval stages). */
	reportingUserIds: string[];
	problems: string[];
	/** The same problems, split by which workflow (WF1 / WF2) the stage belongs to. */
	phaseProblems: Record<Phase, string[]>;
	/** True when the stages cannot be laid out at all (plant slot unknown), whoever is assigned. */
	structural: boolean;
	feeding: { roleKey: string; users: string[] };
};

/**
 * The stages of ONE rule for ONE category / plant slot. Used by the submit plan and by
 * the template catalog (with an empty matrix to learn the shape of every template, and
 * with the real matrix to fill it).
 */
export function buildStagesForRule(args: {
	ruleId: string;
	category: string;
	plantSlot: "DWD" | "KGP" | null;
	def: ConditionDef;
	slots: SlotMap;
	/** Only used to word the problem message. */
	plantLabel?: string;
}): BuiltStages | null {
	const { ruleId, category, plantSlot, def, slots, plantLabel } = args;
	const chain = getChain(ruleId);
	if (!chain) return null;

	const problems: string[] = [];
	const phaseProblems: Record<Phase, string[]> = { WF1: [], WF2: [] };
	const stages: PlanStage[] = [];
	const reportingUserIds: string[] = [];
	let structural = false;
	const addProblem = (phase: Phase, message: string) => {
		problems.push(message);
		phaseProblems[phase].push(message);
	};

	for (const step of chain.steps) {
		if (step.kind === "PROPOSER") continue;

		const roles = effectiveRoles(step, category, def);
		if (roles === null) continue;

		const perRole = roles.map((roleKey) => ({ roleKey, ...usersFor(slots, roleKey, plantSlot) }));
		const label = `${step.label} · ${step.title}`;

		if (perRole.some((r) => r.missingPlant)) {
			structural = true;
			addProblem(
				step.stage,
				`${label}: the plant is "${plantLabel ?? "not KGP or DWD"}", so the KGP/DWD person cannot be chosen (open question Q28).`,
			);
			continue;
		}

		const users = unique(perRole.flatMap((r) => r.users));
		const seats = perRole.map((r) => slotKey(r.roleKey, r.scope));

		if (step.kind === "REPORTING") {
			reportingUserIds.push(...users);
			continue;
		}

		if (step.kind === "COMMITTEE") {
			const required = step.required ?? 3;
			if (users.length < required)
				addProblem(
					step.stage,
					`${label}: needs ${required} different people but only ${users.length} are assigned. Assign at least ${required} different committee members.`,
				);
			stages.push({
				name: label,
				stageOrder: stages.length + 1,
				strategy: "SOME",
				minApprovals: required,
				approverIds: users,
				phase: step.stage,
				roleKeys: roles,
				slots: seats,
			});
			continue;
		}

		if (step.mode === "ANY_ONE") {
			if (users.length === 0)
				addProblem(step.stage, `${label}: nobody is assigned to ${roles.join(" / ")}.`);
			stages.push({
				name: label,
				stageOrder: stages.length + 1,
				strategy: "ANY",
				approverIds: users,
				phase: step.stage,
				roleKeys: roles,
				slots: seats,
			});
			continue;
		}

		// One seat. If the admin put two people in it, either one can act (ANY),
		// so a holiday or a leaver never leaves a request stuck.
		if (users.length === 0) {
			const scope = perRole[0]?.scope ?? "ALL";
			addProblem(step.stage, `${label}: nobody is assigned to ${roles.join(" / ")} (${scope}).`);
		}
		stages.push({
			name: label,
			stageOrder: stages.length + 1,
			strategy: users.length > 1 ? "ANY" : "ALL",
			approverIds: users,
			phase: step.stage,
			roleKeys: roles,
			slots: seats,
		});
	}

	const feeding = usersFor(slots, chain.priceFeeding.roleKey, plantSlot);
	if (feeding.missingPlant) structural = true;

	return {
		stages,
		reportingUserIds: unique(reportingUserIds),
		problems,
		phaseProblems,
		structural,
		feeding: { roleKey: chain.priceFeeding.roleKey, users: unique(feeding.users) },
	};
}

export function buildCppApprovalPlan(input: PlanInput): PlanResult {
	const combo = resolveCombination({
		category: input.category,
		plant: input.plant,
		condition: input.condition,
	});
	if (combo.ok === false) return { ok: false, problems: [combo.reason] };

	const def = getConditionDef(input.condition)!;
	const picked = pickRule(input, combo.block, def);
	if ("problem" in picked) return { ok: false, problems: [picked.problem] };

	const built = buildStagesForRule({
		ruleId: picked.ruleId,
		category: input.category,
		plantSlot: combo.plantSlot,
		def,
		slots: input.slots,
		plantLabel: input.plant,
	});
	if (!built) return { ok: false, problems: [`No approval chain is defined for ${picked.ruleId}.`] };

	const problems = [...built.problems];
	// The price-feeding task comes after the approvals; check it now so the
	// request can never get stuck at the very end.
	if (built.feeding.users.length === 0)
		problems.push(`Price feeding: nobody is assigned to ${built.feeding.roleKey}.`);
	if (built.stages.length === 0) problems.push("The approval chain has no approval stages.");
	if (problems.length) return { ok: false, problems };

	return {
		ok: true,
		ruleId: picked.ruleId,
		bandLabel: picked.label,
		level: picked.level,
		block: combo.block,
		stages: built.stages,
		priceFeedingUserIds: built.feeding.users,
		reportingUserIds: built.reportingUserIds,
		warnings: [...combo.warnings],
	};
}

/* =================================== CATALOG =================================== */

/** Marks templates owned by the approval matrix (metaData_3). Nothing else uses this value. */
export const CPP_TEMPLATE_TAG = "CPP_MATRIX";

type SeatStage = Pick<PlanStage, "slots">;

export const signatureOf = (stages: SeatStage[]): string =>
	stages.map((stage) => stage.slots.join("+")).join(">");

export const shapeHash = (stages: SeatStage[]): string =>
	createHash("sha1").update(signatureOf(stages)).digest("hex").slice(0, 10);

/** Identifies a template: which workflow part + which shape. Stored as metaData_1 | metaData_2. */
export const templateKey = (phase: Phase, stages: SeatStage[]): string =>
	`${phase}|${shapeHash(stages)}`;

/** Splits a plan's stages into the WF1 part and the WF2 part, each numbered from 1. */
export const splitByPhase = <T extends { phase: Phase; stageOrder: number }>(
	stages: T[],
): { WF1: T[]; WF2: T[] } => {
	const part = (phase: Phase) =>
		stages.filter((s) => s.phase === phase).map((s, i) => ({ ...s, stageOrder: i + 1 }));
	return { WF1: part("WF1"), WF2: part("WF2") };
};

export type CatalogEntry = {
	key: string;
	phase: Phase;
	hash: string;
	name: string;
	description: string;
	/** Matrix seats behind each stage of this template, in order. */
	stageSeats: string[][];
	/** One real combination of this shape, used to fill it from the matrix. */
	rep: { ruleId: string; category: string; plantSlot: "DWD" | "KGP" | null; def: ConditionDef };
};

/* ---- wording ---- */

const SHORT_CONDITION: Record<string, string> = {
	FIRST_TIME_REGULAR: "First time & Regular",
	PRICE_CHANGE: "Price change",
	STEEL_COMMODITY: "Steel commodity",
	EMERGENCY_ONETIME: "Emergency one-time",
	PROTOTYPE: "Prototype",
	FIRST_TIME_INDIRECT: "First time indirect",
	PRICE_VARIATION_INDIRECT: "Price variation indirect",
	ONETIME_INDIRECT: "One-time indirect",
	CRUDE_OIL: "Crude oil",
};

const CATEGORY_LABEL: Record<string, string> = {
	CFM: "CFM",
	SM: "SM",
	FAB: "FAB",
	DOMP: "DOMP",
	ERH: "ERH",
	Indirect: "Indirect",
	IMPORT_HCM: "Import HCM",
	IMPORT_NON_HCM: "Import NON HCM",
	SPARES: "Spares",
	STEEL: "Steel",
};

const LEVEL_LABEL: Record<string, string> = {
	L1: "Level 1",
	L2: "Level 2",
	L3: "Level 3",
	L1_MD_REPORTING: "Level 1 (MD informed)",
};

const conditionName = (def: ConditionDef) => def.sheet.replace(/^\d+\s*\.\s*/, "").trim();
const sortStrings = (list: Iterable<string>) => [...list].sort((a, b) => a.localeCompare(b));
const joinAnd = (list: string[]) =>
	list.length <= 1
		? (list[0] ?? "")
		: `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

/** "FTR-M-01, FTR-M-02, FTR-M-03, PC-M-01" -> "FTR-M-01 to 03, PC-M-01" */
const compressRuleIds = (ids: string[]): string => {
	const byPrefix = new Map<string, number[]>();
	for (const id of ids) {
		const cut = id.lastIndexOf("-");
		const prefix = id.slice(0, cut);
		const list = byPrefix.get(prefix) ?? [];
		list.push(Number(id.slice(cut + 1)));
		byPrefix.set(prefix, list);
	}
	const two = (n: number) => String(n).padStart(2, "0");
	const out: string[] = [];
	for (const [prefix, nums] of [...byPrefix].sort(([a], [b]) => a.localeCompare(b))) {
		nums.sort((a, b) => a - b);
		let i = 0;
		while (i < nums.length) {
			let j = i;
			while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
			out.push(j > i ? `${prefix}-${two(nums[i])} to ${two(nums[j])}` : `${prefix}-${two(nums[i])}`);
			i = j + 1;
		}
	}
	return out.join(", ");
};

const levelsText = (levels: Iterable<string>) =>
	joinAnd(sortStrings(levels).map((l) => LEVEL_LABEL[l] ?? l));

type RuleInfo = {
	def: ConditionDef;
	level: string;
	band: string;
	hasWf2: boolean;
	hasMd: boolean;
	feeding: string;
};
type Group = {
	key: string;
	phase: Phase;
	hash: string;
	stageNames: string[];
	stageSeats: string[][];
	rep: CatalogEntry["rep"];
	rules: Map<string, RuleInfo>;
	cats: Set<string>;
	plants: Set<string>;
};

const PEOPLE_NOTE =
	"People come from the CPP approval matrix. You can edit approvers here; requests already running keep their approvals.";

const describeWf1 = (group: Group): string => {
	const rules = [...group.rules.entries()];
	const defs = new Map<string, ConditionDef>();
	rules.forEach(([, r]) => defs.set(r.def.code, r.def));
	const conditions = [...defs.values()].map((def) => {
		const ids = rules.filter(([, r]) => r.def.code === def.code).map(([id]) => id);
		return `${conditionName(def)} (${compressRuleIds(ids)})`;
	});
	const cats = sortStrings([...group.cats].map((c) => CATEGORY_LABEL[c] ?? c));
	const withWf2 = rules.filter(([, r]) => r.hasWf2);
	const without = rules.filter(([, r]) => !r.hasWf2);
	const chain = group.stageNames.map((name, i) => `${i + 1}. ${name}`).join(" → ");
	const feeding = rules[0]?.[1].feeding;

	const parts = [
		`Plant / SCM approval chain (WF1) for ${[...defs.values()][0].group === "INDIRECT" ? "indirect" : "direct"} material.`,
		`Condition${defs.size > 1 ? "s" : ""}: ${conditions.join("; ")}.`,
		`Categor${cats.length > 1 ? "ies" : "y"}: ${cats.join(", ")}.`,
		`Approval levels: ${levelsText(new Set(rules.map(([, r]) => r.level)))}.`,
		`Stages: ${chain}.`,
	];
	if (withWf2.length)
		parts.push(
			`${levelsText(new Set(withWf2.map(([, r]) => r.level)))} requests continue to the CPP committee template (WF2) after this chain.`,
		);
	if (without.length)
		parts.push(
			`${levelsText(new Set(without.map(([, r]) => r.level)))} requests end here (no committee).`,
		);
	if (feeding)
		parts.push(`After approval the price-feeding task goes to: ${getRole(feeding)?.label ?? feeding}.`);
	parts.push(PEOPLE_NOTE);
	return parts.join(" ");
};

const describeWf2 = (group: Group, withMd: boolean): string => {
	const rules = [...group.rules.entries()];
	const defs = new Map<string, ConditionDef>();
	rules.forEach(([, r]) => defs.set(r.def.code, r.def));
	const used = [...defs.values()].map((def) => {
		const mine = rules.filter(([, r]) => r.def.code === def.code);
		return `${conditionName(def)} (${levelsText(new Set(mine.map(([, r]) => r.level)))})`;
	});
	return [
		"CPP committee approval (WF2), the same for every plant and category.",
		"3 of the 7 committee members must approve, then the Alt Chairman or the Chairman (either one) approves.",
		withMd
			? "The Managing Director approves last (MD is added only for the bands below)."
			: "No MD stage for these bands.",
		`Used after the plant / SCM chain (WF1) for: ${used.join("; ")}.`,
		PEOPLE_NOTE,
	].join(" ");
};

const isMdSeat = (seat: string) => seat.startsWith("MD_THCM:");

let catalogCache: Map<string, CatalogEntry> | null = null;

/** Every template CPP can ever need. Built once; it only depends on the rules in code. */
export const getTemplateCatalog = (): Map<string, CatalogEntry> => {
	if (catalogCache) return catalogCache;

	const groups = new Map<string, Group>();
	const empty: SlotMap = new Map();

	for (const def of CPP_CONDITIONS_DEF)
		for (const category of CPP_CATEGORIES)
			for (const plant of CPP_PLANTS) {
				const combo = resolveCombination({ category, plant, condition: def.code });
				if (combo.ok === false) continue;
				const grid = combo.block === "SPARES" && def.spareGrid ? def.spareGrid : def.grid;

				combo.ruleIds.forEach((ruleId, index) => {
					const built = buildStagesForRule({
						ruleId,
						category,
						plantSlot: combo.plantSlot,
						def,
						slots: empty,
					});
					if (!built || built.structural || built.stages.length === 0) return;
					const chain = getChain(ruleId);
					const parts = splitByPhase(built.stages);

					for (const phase of ["WF1", "WF2"] as Phase[]) {
						const stages = parts[phase];
						if (stages.length === 0) continue;
						const key = templateKey(phase, stages);
						let group = groups.get(key);
						if (!group) {
							group = {
								key,
								phase,
								hash: shapeHash(stages),
								stageNames: stages.map((s) => s.name),
								stageSeats: stages.map((s) => s.slots),
								rep: { ruleId, category, plantSlot: combo.plantSlot, def },
								rules: new Map(),
								cats: new Set(),
								plants: new Set(),
							};
							groups.set(key, group);
						}
						group.rules.set(ruleId, {
							def,
							level: grid[index].level,
							band: grid[index].label,
							hasWf2: parts.WF2.length > 0,
							hasMd: parts.WF2.some((s) => s.slots.some(isMdSeat)),
							feeding: chain?.priceFeeding.roleKey ?? "",
						});
						group.cats.add(category);
						group.plants.add(plant);
					}
				});
			}

	const catalog = new Map<string, CatalogEntry>();
	const usedNames = new Set<string>();
	const allDirect = CPP_CONDITIONS_DEF.filter((d) => d.group === "DIRECT").length;
	const allIndirect = CPP_CONDITIONS_DEF.filter((d) => d.group === "INDIRECT").length;

	for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
		let name: string;
		let description: string;

		if (group.phase === "WF2") {
			const withMd = group.stageSeats.some((seats) => seats.some(isMdSeat));
			name = `CPP WF2 · Committee, Alt Chairman / Chairman${withMd ? " and MD" : ""}`;
			description = describeWf2(group, withMd);
		} else {
			const defs = new Map<string, ConditionDef>();
			group.rules.forEach((r) => defs.set(r.def.code, r.def));
			const list = [...defs.values()];
			const isIndirect = list[0].group === "INDIRECT";
			const conditionText =
				list.length === (isIndirect ? allIndirect : allDirect)
					? `All ${isIndirect ? "indirect" : "direct"} conditions`
					: list.map((d) => SHORT_CONDITION[d.code] ?? conditionName(d)).join(" + ");
			const cats = sortStrings([...group.cats].map((c) => CATEGORY_LABEL[c] ?? c)).join("/");
			const seats = group.stageSeats.flat();
			const plantText = seats.some((s) => s.endsWith(":KGP"))
				? "KGP"
				: seats.some((s) => s.endsWith(":DWD"))
					? "DWD"
					: "All plants";
			name = `CPP WF1 · ${conditionText} · ${cats} · ${plantText}`;
			description = describeWf1(group);
		}

		// Two shapes must never share a name: add the stage count, then the shape id.
		if (usedNames.has(name)) name = `${name} · ${group.stageSeats.length} stages`;
		if (usedNames.has(name)) name = `${name} · ${group.hash}`;
		usedNames.add(name);

		catalog.set(group.key, {
			key: group.key,
			phase: group.phase,
			hash: group.hash,
			name,
			description,
			stageSeats: group.stageSeats,
			rep: group.rep,
		});
	}

	catalogCache = catalog;
	return catalog;
};

export type DesiredTemplate = CatalogEntry & { stages: PlanStage[]; problems: string[] };

/** The stages of one catalog entry filled with a matrix. `problems` non-empty = not ready (empty seat, committee too small). */
export const fillTemplate = (entry: CatalogEntry, slots: SlotMap): DesiredTemplate => {
	const built = buildStagesForRule({
		ruleId: entry.rep.ruleId,
		category: entry.rep.category,
		plantSlot: entry.rep.plantSlot,
		def: entry.rep.def,
		slots,
	});
	return {
		...entry,
		stages: built ? splitByPhase(built.stages)[entry.phase] : [],
		problems: built
			? built.phaseProblems[entry.phase]
			: [`No approval chain is defined for ${entry.rep.ruleId}.`],
	};
};

/** Every template filled with a matrix. */
export const desiredTemplates = (slots: SlotMap): DesiredTemplate[] =>
	[...getTemplateCatalog().values()].map((entry) => fillTemplate(entry, slots));

// cpp.template.catalog.ts — the list of reusable approval templates CPP needs.
// Pure: no database.
//
// A request's approval has two parts, and each part has its own template:
//   WF1  plant / SCM chain      (Category Head … SCM Head). Differs by category, plant and band.
//   WF2  CPP committee          (committee 3 of 7 → Alt Chairman / Chairman → MD for some bands).
//        Almost always the same, so only two WF2 templates exist (with / without MD).
// Many bands share one template, so the whole module needs a few dozen templates,
// not one per band.
//
// The SHAPE of each template (which roles, in which order) comes from the rules in
// code. The PEOPLE come from the approval matrix and are filled in by cpp.template.sync.ts.
import { createHash } from "crypto";

import { getRole } from "./cpp.constants";
import type { SlotMap } from "./cpp.helper";
import {
	CPP_CATEGORIES,
	CPP_CONDITIONS_DEF,
	CPP_PLANTS,
	type ConditionDef,
	getChain,
	resolveCombination,
} from "./cpp.rules";
import { buildStagesForRule, type PlanStage } from "./cpp.workflow";

/** Marks templates owned by the approval matrix (metaData_3). Nothing else uses this value. */
export const CPP_TEMPLATE_TAG = "CPP_MATRIX";

export type Phase = "WF1" | "WF2";

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
		stages
			.filter((s) => s.phase === phase)
			.map((s, i) => ({ ...s, stageOrder: i + 1 }));
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
	rep: {
		ruleId: string;
		category: string;
		plantSlot: "DWD" | "KGP" | null;
		def: ConditionDef;
	};
};

/* ------------------------------ wording ------------------------------ */

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

const conditionName = (def: ConditionDef) =>
	def.sheet.replace(/^\d+\s*\.\s*/, "").trim();
const sortStrings = (list: Iterable<string>) =>
	[...list].sort((a, b) => a.localeCompare(b));
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
	for (const [prefix, nums] of [...byPrefix].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		nums.sort((a, b) => a - b);
		let i = 0;
		while (i < nums.length) {
			let j = i;
			while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
			out.push(
				j > i
					? `${prefix}-${two(nums[i])} to ${two(nums[j])}`
					: `${prefix}-${two(nums[i])}`,
			);
			i = j + 1;
		}
	}
	return out.join(", ");
};

const levelsText = (levels: Iterable<string>) =>
	joinAnd(sortStrings(levels).map((l) => LEVEL_LABEL[l] ?? l));

/* ------------------------------ catalog ------------------------------ */

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

let cache: Map<string, CatalogEntry> | null = null;

const describeWf1 = (group: Group): string => {
	const rules = [...group.rules.entries()];
	const defs = new Map<string, ConditionDef>();
	rules.forEach(([, r]) => defs.set(r.def.code, r.def));
	const conditions = [...defs.values()].map((def) => {
		const ids = rules
			.filter(([, r]) => r.def.code === def.code)
			.map(([id]) => id);
		return `${conditionName(def)} (${compressRuleIds(ids)})`;
	});
	const cats = sortStrings([...group.cats].map((c) => CATEGORY_LABEL[c] ?? c));
	const withWf2 = rules.filter(([, r]) => r.hasWf2);
	const without = rules.filter(([, r]) => !r.hasWf2);
	const chain = group.stageNames
		.map((name, i) => `${i + 1}. ${name}`)
		.join(" → ");
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
		parts.push(
			`After approval the price-feeding task goes to: ${getRole(feeding)?.label ?? feeding}.`,
		);
	parts.push(
		"People come from the CPP approval matrix. You can edit approvers here; requests already running keep their approvals.",
	);
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
		"People come from the CPP approval matrix. You can edit approvers here; requests already running keep their approvals.",
	].join(" ");
};

/** Every template CPP can ever need. Built once; it only depends on the rules in code. */
export const getTemplateCatalog = (): Map<string, CatalogEntry> => {
	if (cache) return cache;

	const groups = new Map<string, Group>();
	const empty: SlotMap = new Map();

	for (const def of CPP_CONDITIONS_DEF)
		for (const category of CPP_CATEGORIES)
			for (const plant of CPP_PLANTS) {
				const combo = resolveCombination({
					category,
					plant,
					condition: def.code,
				});
				if (!combo.ok) continue;
				const grid =
					combo.block === "SPARES" && def.spareGrid ? def.spareGrid : def.grid;

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
							hasMd: parts.WF2.some((s) =>
								s.slots.some((seat) => seat.startsWith("MD_THCM:")),
							),
							feeding: chain?.priceFeeding.roleKey ?? "",
						});
						group.cats.add(category);
						group.plants.add(plant);
					}
				});
			}

	const catalog = new Map<string, CatalogEntry>();
	const usedNames = new Set<string>();
	const allDirect = CPP_CONDITIONS_DEF.filter(
		(d) => d.group === "DIRECT",
	).length;
	const allIndirect = CPP_CONDITIONS_DEF.filter(
		(d) => d.group === "INDIRECT",
	).length;

	for (const group of [...groups.values()].sort((a, b) =>
		a.key.localeCompare(b.key),
	)) {
		let name: string;
		let description: string;

		if (group.phase === "WF2") {
			const withMd = group.stageSeats.some((seats) =>
				seats.some((seat) => seat.startsWith("MD_THCM:")),
			);
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
					: list
							.map((d) => SHORT_CONDITION[d.code] ?? conditionName(d))
							.join(" + ");
			const cats = sortStrings(
				[...group.cats].map((c) => CATEGORY_LABEL[c] ?? c),
			).join("/");
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
		if (usedNames.has(name))
			name = `${name} · ${group.stageSeats.length} stages`;
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

	cache = catalog;
	return catalog;
};

export type DesiredTemplate = CatalogEntry & {
	stages: PlanStage[];
	problems: string[];
};

/** The stages of one catalog entry filled with a matrix. `problems` non-empty = not ready (empty seat, committee too small). */
export const fillTemplate = (
	entry: CatalogEntry,
	slots: SlotMap,
): DesiredTemplate => {
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

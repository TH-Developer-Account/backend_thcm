// cpp.workflow.ts — turns a saved CPP request + the approval matrix into the
// stage list of ONE workflow (WF1 stages, then WF2 stages, in order).
// Pure: no DB, no Express. The controller loads the rows and feeds them in.
//
//  - Band:   the request's values pick exactly one rule (e.g. FTR-M-02).
//            New requests pick RANGES in the form (partBand / amountBand); requests
//            saved before that still route on their typed numbers.
//  - Chain:  that rule's steps name ROLES; the matrix says who sits in each role.
//  - Result: every problem is collected, so the admin can fix them in one go.
import { getRole, slotKey } from "./cpp.constants";
import type { SlotMap } from "./cpp.helper";
import {
	type Band,
	type CppBlock,
	type CppChainStepRaw,
	type ConditionDef,
	getChain,
	getConditionDef,
	resolveCombination,
} from "./cpp.rules";

/** Q13 default: for Import NON HCM, "Head - SCM KGP Plant & Imports" REPLACES Head SCM KGP/DWD. */
const IMPORT_NON_HCM_REPLACES_HEAD_SCM = true;
const HEAD_SCM = "HEAD_SCM";
const HEAD_SCM_IMPORTS = "HEAD_SCM_KGP_PLANT_IMPORTS";

export type PlanStage = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals?: number;
	approverIds: string[];
	/** Which part of the lifecycle this stage belongs to. */
	phase: "WF1" | "WF2";
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

/**
 * Range key shared with the frontend dropdowns (utils/cpp.bands.ts):
 * `${gt}_${lte}`, an open side left empty. Both sides build it from the same
 * grid numbers, so a picked option matches exactly one grid cell.
 */
export const bandKey = (band: Band): string =>
	`${band.gt ?? ""}_${band.lte ?? ""}`;

const inBand = (value: number, band: Band): boolean =>
	(band.gt === undefined || value > band.gt) &&
	(band.lte === undefined || value <= band.lte);

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
				bandKey(cell.amount) === amountBand &&
				(!cell.part || bandKey(cell.part) === partBand),
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
		return {
			problem:
				"The approval amount is missing or zero, so no approval band applies.",
		};

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
			inBand(amount, cell.amount) &&
			(!cell.part || (part !== null && inBand(part, cell.part))),
	);
	if (index < 0)
		return {
			problem:
				"No approval band matches these values (check the amount and part value).",
		};

	return ruleOf(index);
}

const usersFor = (
	slots: SlotMap,
	roleKey: string,
	plantSlot: string | null,
) => {
	const role = getRole(roleKey);
	if (!role)
		return { users: [] as string[], scope: "ALL", missingPlant: false };
	if (role.scope === "PLANT") {
		if (!plantSlot) return { users: [], scope: "PLANT", missingPlant: true };
		return {
			users: slots.get(slotKey(roleKey, plantSlot)) ?? [],
			scope: plantSlot,
			missingPlant: false,
		};
	}
	return {
		users: slots.get(slotKey(roleKey, "ALL")) ?? [],
		scope: "ALL",
		missingPlant: false,
	};
};

const unique = (ids: string[]) => [...new Set(ids)];

/** Role keys a step really uses for this category (variant swap, DOMP skip, Import NON HCM reroute). */
const effectiveRoles = (
	step: CppChainStepRaw,
	category: string,
	def: ConditionDef,
): string[] | null => {
	if (
		category === "DOMP" &&
		def.notes.includes("N_DOMP_SKIP") &&
		step.roleKeys.includes(HEAD_SCM)
	)
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
	phaseProblems: Record<"WF1" | "WF2", string[]>;
	/** True when the stages cannot be laid out at all (plant slot unknown), whoever is assigned. */
	structural: boolean;
	feeding: { roleKey: string; users: string[] };
};

/**
 * The stages of ONE rule for ONE category / plant slot. Used by the submit plan
 * and by the template builder (which calls it with an empty matrix to learn the
 * shape of every template, and with the real matrix to fill it).
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
	const phaseProblems: Record<"WF1" | "WF2", string[]> = { WF1: [], WF2: [] };
	const stages: PlanStage[] = [];
	const reportingUserIds: string[] = [];
	let structural = false;
	const addProblem = (phase: "WF1" | "WF2", text: string) => {
		problems.push(text);
		phaseProblems[phase].push(text);
	};

	for (const step of chain.steps) {
		if (step.kind === "PROPOSER") continue;

		const roles = effectiveRoles(step, category, def);
		if (roles === null) continue;

		const perRole = roles.map((roleKey) => ({
			roleKey,
			...usersFor(slots, roleKey, plantSlot),
		}));
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
				addProblem(
					step.stage,
					`${label}: nobody is assigned to ${roles.join(" / ")}.`,
				);
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
			addProblem(
				step.stage,
				`${label}: nobody is assigned to ${roles.join(" / ")} (${scope}).`,
			);
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
		feeding: {
			roleKey: chain.priceFeeding.roleKey,
			users: unique(feeding.users),
		},
	};
}

export function buildCppApprovalPlan(input: PlanInput): PlanResult {
	const combo = resolveCombination({
		category: input.category,
		plant: input.plant,
		condition: input.condition,
	});
	if (!combo.ok)
		return { ok: false, problems: [(combo as { reason: string }).reason] };

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
	if (!built)
		return {
			ok: false,
			problems: [`No approval chain is defined for ${picked.ruleId}.`],
		};

	const problems = [...built.problems];
	const warnings = [...combo.warnings];

	// The price-feeding task comes after the approvals; check it now so the
	// request can never get stuck at the very end.
	if (built.feeding.users.length === 0)
		problems.push(
			`Price feeding: nobody is assigned to ${built.feeding.roleKey}.`,
		);

	if (built.stages.length === 0)
		problems.push("The approval chain has no approval stages.");
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
		warnings,
	};
}

import { CPP_CHAINS_RAW } from "./cpp.chains.data";
import { getRole } from "./cpp.constants";

/* ===== rules ===== */
// cpp.rules.ts — which category × plant × condition combinations exist, and
// which approval bands + workbook notes apply to each.
// Pure data + pure functions: no DB, no Express. Source: CPP_Apprval_Flow_Matrix.xlsx.
// The approval CHAIN (who approves) is NOT here — it comes later from the slot table.

export const CPP_PLANTS = ["DWD", "KGP", "Spares"] as const;
export type CppPlant = (typeof CPP_PLANTS)[number];

// Values match the frontend CPP_CATEGORY_LABELS keys exactly.
export const CPP_CATEGORIES = [
	"CFM",
	"SM",
	"FAB",
	"DOMP",
	"ERH",
	"Indirect",
	"IMPORT_HCM",
	"IMPORT_NON_HCM",
	"SPARES",
	"STEEL",
] as const;
export type CppCategory = (typeof CPP_CATEGORIES)[number];

export const CPP_CONDITION_CODES = [
	"FIRST_TIME_REGULAR",
	"PRICE_CHANGE",
	"STEEL_COMMODITY",
	"EMERGENCY_ONETIME",
	"PROTOTYPE",
	"FIRST_TIME_INDIRECT",
	"PRICE_VARIATION_INDIRECT",
	"ONETIME_INDIRECT",
	"CRUDE_OIL",
] as const;
export type CppConditionCode = (typeof CPP_CONDITION_CODES)[number];

export type CppPartBasis = "PART_VALUE" | "VARIATION_PCT" | null;
export type CppAmountBasis =
	| "ANNUALISED_VALUE"
	| "ANNUALISED_IMPACT"
	| "ACTUAL_IMPACT";
export type CppLevel = "L1" | "L2" | "L3" | "L1_MD_REPORTING";
export type CppBlock = "MAIN" | "SPARES";

const LAC = 100_000;
const CR = 10_000_000;

/** Band edge. Upper bound belongs to the LOWER band (open question Q6). */
export type Band = { gt?: number; lte?: number };

export type RuleCell = {
	part?: Band; // only when the condition has a part basis
	amount: Band;
	level: CppLevel;
	/** Workbook wording, kept for traceability. */
	label: string;
};

export type ConditionDef = {
	code: CppConditionCode;
	ruleIdPrefix: string;
	sheet: string;
	group: "DIRECT" | "INDIRECT";
	partBasis: CppPartBasis;
	amountBasis: CppAmountBasis;
	hasSpareBlock: boolean;
	/** Same band grid for MAIN and SPARES unless `spareGrid` overrides it. */
	grid: RuleCell[];
	spareGrid?: RuleCell[];
	/** Workbook notes that apply to this sheet (see CPP_NOTES). */
	notes: CppNoteId[];
};

/* ------------------------------- notes -------------------------------- */

export type CppNoteId =
	| "N_DOMP_SKIP"
	| "N_IMPORT_NON_HCM"
	| "N_RECOMMENDER"
	| "N_RECOMMENDER_NO_IMPORTS"
	| "N_COMMITTEE_3_OF_7"
	| "N_ALT_CHAIRMAN_PARALLEL"
	| "N_OUT_OF_5_TYPO"
	| "N_MD_REPORTING"
	| "N_CRUDE_SPARES_GAP"
	| "N_SPARES_EXTRA_STAGES"
	| "N_PRICE_FEEDING";

export const CPP_NOTES: Record<
	CppNoteId,
	{ text: string; source: string; question?: string }
> = {
	N_DOMP_SKIP: {
		text: "Category DOMP: skip the approval of Head SCM KGP / Head SCM DWD.",
		source: "Sheets 1,2,4,5 — Note row (B23)",
		question: "Q12 (also applied to the Spares blocks?)",
	},
	N_IMPORT_NON_HCM: {
		text: "Category Import NON HCM: after Cost Controller go to 'Head - SCM KGP Plant & Imports'.",
		source: "Sheets 1,2,4,5 — Note row (B24)",
		question: "Q13 (replaces or precedes Head SCM?)",
	},
	N_RECOMMENDER: {
		text: "Second recommender depends on category: Head Component Development (plant) / Vertical Head Proprietary & Imports / Head Imports Procurement.",
		source: "Sheets 1,2 — recommender row (B8)",
		question: "Q11",
	},
	N_RECOMMENDER_NO_IMPORTS: {
		text: "This sheet lists only 'Head Component Development / Vertical Head Proprietary & Imports' — no recommender is defined for Import HCM / NON HCM.",
		source: "Sheets 4,5 and Price Change >15% block",
		question: "Q11",
	},
	N_COMMITTEE_3_OF_7: {
		text: "CPP committee: out of 7 members, 3 approvals required (Level 2 and 3 only).",
		source: "Every sheet — committee row",
		question: "Q14",
	},
	N_ALT_CHAIRMAN_PARALLEL: {
		text: "Alt Chairman: parallel flow with the committee, but approval is mandatory.",
		source: "Sheet 7 (G16)",
		question: "Q15",
	},
	N_OUT_OF_5_TYPO: {
		text: "Sheet says 'Out of 5 members - 3 approval' while the rest say 'Out of 7'.",
		source: "Sheets 7 (K30), 8 (G30)",
		question: "Q14",
	},
	N_MD_REPORTING: {
		text: "Above Rs. 25 Lacs the MD is 'Reporting' (inform), not an approval stage.",
		source: "Sheet 9 (E8)",
		question: "Q20",
	},
	N_CRUDE_SPARES_GAP: {
		text: "Crude oil Spares bands say 'up to 10 Lacs' and 'more than 25': nothing is defined between 10 and 25 Lacs.",
		source: "Sheet 9 Spares block",
		question: "Q8",
	},
	N_SPARES_EXTRA_STAGES: {
		text: "Spares flow adds Category Head Spares Sourcing (direct) / Spares Head (indirect) and Head Spare Parts.",
		source: "Spares blocks of sheets 1–8, 9",
		question: "Q3",
	},
	N_PRICE_FEEDING: {
		text: "Price-feeding approval is a separate second workflow after the main approval; the lowest bands list none.",
		source: "Last row of every block",
		question: "Q18",
	},
};

/* ---------------------------- band grids ------------------------------ */

const cell = (
	level: CppLevel,
	label: string,
	amount: Band,
	part?: Band,
): RuleCell => ({ level, label, amount, ...(part ? { part } : {}) });

// Per-part value bands (rupees) — sheets 1 and 5.
const P_LT_10K: Band = { lte: 10_000 };
const P_10K_1L: Band = { gt: 10_000, lte: LAC };
const P_GT_1L: Band = { gt: LAC };
// Price-variation % bands — sheet 2 (absolute %).
const V_LT_5: Band = { lte: 5 };
const V_5_15: Band = { gt: 5, lte: 15 };
const V_GT_15: Band = { gt: 15 };

const upTo = (n: number): Band => ({ lte: n });
const between = (a: number, b: number): Band => ({ gt: a, lte: b });
const above = (n: number): Band => ({ gt: n });

export const CPP_CONDITIONS_DEF: ConditionDef[] = [
	{
		code: "FIRST_TIME_REGULAR",
		ruleIdPrefix: "FTR",
		sheet: "1.First time & Regular Purchase",
		group: "DIRECT",
		partBasis: "PART_VALUE",
		amountBasis: "ANNUALISED_VALUE",
		hasSpareBlock: true,
		notes: [
			"N_DOMP_SKIP",
			"N_IMPORT_NON_HCM",
			"N_RECOMMENDER",
			"N_COMMITTEE_3_OF_7",
			"N_PRICE_FEEDING",
		],
		grid: [
			cell("L1", "<10K/part, value up to 10 L", upTo(10 * LAC), P_LT_10K),
			cell("L2", "<10K/part, 10 L–2 Cr", between(10 * LAC, 2 * CR), P_LT_10K),
			cell("L3", "<10K/part, above 2 Cr", above(2 * CR), P_LT_10K),
			cell("L2", "10K–1 L/part, up to 2 Cr", between(0, 2 * CR), P_10K_1L),
			cell("L3", "10K–1 L/part, above 2 Cr", above(2 * CR), P_10K_1L),
			cell("L3", ">1 L/part, any value", above(0), P_GT_1L),
		],
	},
	{
		code: "PRICE_CHANGE",
		ruleIdPrefix: "PC",
		sheet: "2 .Price Change",
		group: "DIRECT",
		partBasis: "VARIATION_PCT",
		amountBasis: "ANNUALISED_IMPACT",
		hasSpareBlock: true,
		notes: [
			"N_DOMP_SKIP",
			"N_IMPORT_NON_HCM",
			"N_RECOMMENDER",
			"N_RECOMMENDER_NO_IMPORTS",
			"N_COMMITTEE_3_OF_7",
			"N_PRICE_FEEDING",
		],
		grid: [
			cell("L1", "<5%, impact up to 5 L", upTo(5 * LAC), V_LT_5),
			cell("L2", "<5%, 5 L–1 Cr", between(5 * LAC, CR), V_LT_5),
			cell("L3", "<5%, above 1 Cr", above(CR), V_LT_5),
			cell("L1", "5–15%, impact up to 1 L", upTo(LAC), V_5_15),
			cell("L2", "5–15%, 1 L–1 Cr", between(LAC, CR), V_5_15),
			cell("L3", "5–15%, above 1 Cr", above(CR), V_5_15),
			cell("L1", ">15%, impact up to 1 L", upTo(LAC), V_GT_15),
			cell("L3", ">15%, above 1 L", above(LAC), V_GT_15),
		],
	},
	{
		code: "STEEL_COMMODITY",
		ruleIdPrefix: "STL",
		sheet: "3. Steel Commodity Price Change",
		group: "DIRECT",
		partBasis: null,
		amountBasis: "ACTUAL_IMPACT",
		hasSpareBlock: false,
		notes: ["N_COMMITTEE_3_OF_7", "N_PRICE_FEEDING"],
		grid: [
			cell("L1", "Actual impact up to 10 L", upTo(10 * LAC)),
			cell("L2", "10 L–50 L", between(10 * LAC, 50 * LAC)),
			cell("L3", "above 50 L", above(50 * LAC)),
		],
	},
	{
		code: "EMERGENCY_ONETIME",
		ruleIdPrefix: "EOP",
		sheet: "4. Emergency Onetime Purchase",
		group: "DIRECT",
		partBasis: null,
		amountBasis: "ANNUALISED_VALUE",
		hasSpareBlock: true,
		notes: [
			"N_DOMP_SKIP",
			"N_IMPORT_NON_HCM",
			"N_RECOMMENDER_NO_IMPORTS",
			"N_COMMITTEE_3_OF_7",
			"N_PRICE_FEEDING",
		],
		grid: [
			cell("L1", "Up to 10 L", upTo(10 * LAC)),
			cell("L2", "10 L–50 L", between(10 * LAC, 50 * LAC)),
			cell("L3", "above 50 L", above(50 * LAC)),
		],
	},
	{
		code: "PROTOTYPE",
		ruleIdPrefix: "PRO",
		sheet: "5. Prototype Development",
		group: "DIRECT",
		partBasis: "PART_VALUE",
		amountBasis: "ANNUALISED_VALUE",
		hasSpareBlock: true,
		notes: [
			"N_DOMP_SKIP",
			"N_IMPORT_NON_HCM",
			"N_RECOMMENDER_NO_IMPORTS",
			"N_COMMITTEE_3_OF_7",
			"N_PRICE_FEEDING",
		],
		grid: [
			cell("L1", "<10K/part, up to 10 L", upTo(10 * LAC), P_LT_10K),
			cell("L2", "<10K/part, 10 L–1 Cr", between(10 * LAC, CR), P_LT_10K),
			cell("L3", "<10K/part, above 1 Cr", above(CR), P_LT_10K),
			cell("L2", "10K–1 L/part, up to 1 Cr", between(0, CR), P_10K_1L),
			cell("L3", "10K–1 L/part, above 1 Cr", above(CR), P_10K_1L),
			cell("L3", ">1 L/part, any value", above(0), P_GT_1L),
		],
	},
	{
		code: "FIRST_TIME_INDIRECT",
		ruleIdPrefix: "IFTR",
		sheet: "6. First time Indirect Material",
		group: "INDIRECT",
		partBasis: null,
		amountBasis: "ANNUALISED_VALUE",
		hasSpareBlock: true,
		notes: ["N_COMMITTEE_3_OF_7", "N_PRICE_FEEDING"],
		grid: [
			cell("L1", "Up to 8 L", upTo(8 * LAC)),
			cell("L2", "8 L–75 L", between(8 * LAC, 75 * LAC)),
			cell("L3", "above 75 L", above(75 * LAC)),
		],
	},
	{
		code: "PRICE_VARIATION_INDIRECT",
		ruleIdPrefix: "IPV",
		sheet: "7. Price Variation Indirect",
		group: "INDIRECT",
		partBasis: null,
		amountBasis: "ANNUALISED_IMPACT",
		hasSpareBlock: true,
		notes: [
			"N_COMMITTEE_3_OF_7",
			"N_ALT_CHAIRMAN_PARALLEL",
			"N_OUT_OF_5_TYPO",
			"N_PRICE_FEEDING",
		],
		grid: [
			cell("L1", "Impact up to 5 L", upTo(5 * LAC)),
			cell("L2", "5 L–25 L", between(5 * LAC, 25 * LAC)),
			cell("L3", "above 25 L", above(25 * LAC)),
		],
	},
	{
		code: "ONETIME_INDIRECT",
		ruleIdPrefix: "IOTP",
		sheet: "8.One Time Purchase of indirect",
		group: "INDIRECT",
		partBasis: null,
		amountBasis: "ANNUALISED_VALUE",
		hasSpareBlock: true,
		notes: ["N_COMMITTEE_3_OF_7", "N_OUT_OF_5_TYPO", "N_PRICE_FEEDING"],
		grid: [
			cell("L1", "Up to 10 L", upTo(10 * LAC)),
			cell("L2", "10 L–50 L", between(10 * LAC, 50 * LAC)),
			cell("L3", "above 50 L", above(50 * LAC)),
		],
	},
	{
		code: "CRUDE_OIL",
		ruleIdPrefix: "CRU",
		sheet: "9. Crude Oil",
		group: "INDIRECT",
		partBasis: null,
		amountBasis: "ANNUALISED_IMPACT",
		hasSpareBlock: true,
		notes: ["N_MD_REPORTING", "N_CRUDE_SPARES_GAP", "N_PRICE_FEEDING"],
		grid: [
			cell("L1", "Impact up to 25 L", upTo(25 * LAC)),
			cell("L1_MD_REPORTING", "above 25 L (MD reporting)", above(25 * LAC)),
		],
		// Workbook says 'up to 10 Lacs' here (Q8: probably a typo for 25).
		spareGrid: [
			cell("L1", "Impact up to 10 L (as written)", upTo(10 * LAC)),
			cell("L1_MD_REPORTING", "above 25 L (MD reporting)", above(25 * LAC)),
		],
	},
];

export const getConditionDef = (code: string): ConditionDef | undefined =>
	CPP_CONDITIONS_DEF.find((def) => def.code === code);

/* ---------------------- combination resolution ------------------------ */

export type CombinationResult =
	| {
			ok: true;
			block: CppBlock;
			isSpare: boolean;
			sheet: string;
			/** The KGP/DWD plant slot. null = not resolvable (plant = Spares, Q28). */
			plantSlot: "DWD" | "KGP" | null;
			ruleIds: string[];
			bandCount: number;
			notes: CppNoteId[];
			warnings: string[];
	  }
	| { ok: false; reason: string };

const isString = <T extends readonly string[]>(
	list: T,
	value: string,
): value is T[number] => (list as readonly string[]).includes(value);

/** Notes that only make sense for certain categories. */
const categoryNotes = (
	def: ConditionDef,
	category: CppCategory,
): CppNoteId[] =>
	def.notes.filter((note) => {
		if (note === "N_DOMP_SKIP") return category === "DOMP";
		if (note === "N_IMPORT_NON_HCM") return category === "IMPORT_NON_HCM";
		if (note === "N_RECOMMENDER")
			return (
				category === "CFM" ||
				category === "SM" ||
				category === "FAB" ||
				category === "ERH" ||
				category === "DOMP" ||
				category === "IMPORT_HCM" ||
				category === "IMPORT_NON_HCM"
			);
		if (note === "N_RECOMMENDER_NO_IMPORTS")
			return category === "IMPORT_HCM" || category === "IMPORT_NON_HCM";
		return true;
	});

export const resolveCombination = (input: {
	category: string;
	plant: string;
	condition: string;
}): CombinationResult => {
	const { category, plant, condition } = input;

	if (!isString(CPP_CATEGORIES, category))
		return { ok: false, reason: `Unknown category "${category}"` };
	if (!isString(CPP_PLANTS, plant))
		return { ok: false, reason: `Unknown plant "${plant}"` };
	const def = getConditionDef(condition);
	if (!def) return { ok: false, reason: `Unknown condition "${condition}"` };

	const isIndirectCategory = category === "Indirect";
	if (isIndirectCategory && def.group !== "INDIRECT")
		return {
			ok: false,
			reason: `"${def.sheet}" is a direct-material condition; the Indirect category can only use indirect conditions.`,
		};
	if (!isIndirectCategory && def.group !== "DIRECT")
		return {
			ok: false,
			reason: `"${def.sheet}" is an indirect-material condition; it needs the Indirect category.`,
		};

	// Assumption A1 (Q24): the steel sheet is the steel category's only scenario.
	if (def.code === "STEEL_COMMODITY" && category !== "STEEL")
		return {
			ok: false,
			reason: "Steel Commodity Price Change applies to the Steel category only.",
		};
	if (category === "STEEL" && def.code !== "STEEL_COMMODITY")
		return {
			ok: false,
			reason: "The Steel category can only use Steel Commodity Price Change.",
		};

	const isSpare = category === "SPARES" || plant === "Spares";
	// Decision (Monica, interim): a sheet with no Spares block (Steel) uses its
	// Main workflow for Spares requests. Revisit when the business confirms.
	const useSpareBlock = isSpare && def.hasSpareBlock;

	const block: CppBlock = useSpareBlock ? "SPARES" : "MAIN";
	const grid = useSpareBlock && def.spareGrid ? def.spareGrid : def.grid;
	const letter = useSpareBlock ? "S" : "M";
	const ruleIds = grid.map(
		(_, i) => `${def.ruleIdPrefix}-${letter}-${String(i + 1).padStart(2, "0")}`,
	);

	const notes = categoryNotes(def, category);
	if (useSpareBlock) notes.push("N_SPARES_EXTRA_STAGES");
	const warnings: string[] = [];
	if (isSpare && !def.hasSpareBlock)
		warnings.push(`"${def.sheet}" has no Spares block: the Main workflow is used (interim decision).`);
	if (plant === "Spares")
		warnings.push(
			"Plant is 'Spares': the KGP/DWD plant slots cannot be resolved yet (open question Q28).",
		);
	if (notes.includes("N_RECOMMENDER_NO_IMPORTS"))
		warnings.push("No second recommender defined for Import categories here (Q11).");

	return {
		ok: true,
		block,
		isSpare,
		sheet: def.sheet,
		plantSlot: plant === "DWD" || plant === "KGP" ? plant : null,
		ruleIds,
		bandCount: grid.length,
		notes,
		warnings,
	};
};

/** Every category × plant × condition, valid or not (for review and tests). */
export const listAllCombinations = () => {
	const rows: Array<{
		category: CppCategory;
		plant: CppPlant;
		condition: CppConditionCode;
		result: CombinationResult;
	}> = [];
	for (const category of CPP_CATEGORIES)
		for (const plant of CPP_PLANTS)
			for (const condition of CPP_CONDITION_CODES)
				rows.push({
					category,
					plant,
					condition,
					result: resolveCombination({ category, plant, condition }),
				});
	return rows;
};

/** Which conditions a category may pick (drives the frontend dropdown). */
export const getAllowedConditions = (category: string): CppConditionCode[] =>
	CPP_CONDITION_CODES.filter(
		(condition) =>
			resolveCombination({ category, plant: "KGP", condition }).ok,
	);

/* ===== chains ===== */
// cpp.chains.ts — the approval chain of every band, split into the workflows
// Monica described:
//   WF 1  plant / SCM chain   (proposer … SCM Head)
//   WF 2  CPP committee       (committee 3 of 7, Alt Chairman / Chairman, MD)
//   then a price-feeding TASK (not an approval) done by the SCM Head.
// The data is generated from the workbook (cpp.chains.data.ts). Everything in
// this file is pure, so it is unit tested without a database.

export type CppStage = "WF1" | "WF2";
export type CppStepKind =
	| "PROPOSER"
	| "RECOMMENDER"
	| "CHECKER"
	| "APPROVER"
	| "COMMITTEE"
	| "REPORTING";

export type CppChainStepRaw = {
	stage: CppStage;
	kind: CppStepKind;
	/** The workbook's own label, e.g. "Approver-2". */
	label: string;
	title: string;
	/** Roles that can act on this step. More than one + mode ANY_ONE = parallel. */
	roleKeys: string[];
	/** ANY_ONE: whoever acts first completes the step (Alt Chairman / Chairman). */
	mode?: "ANY_ONE";
	/** COMMITTEE: how many members must approve. */
	required?: number;
	/** Category-specific replacement role, e.g. { DOMP: "VERTICAL_HEAD_…" }. */
	variants?: Record<string, string>;
	/** This approver also does the price feeding (workbook "Approver / Price feeding"). */
	alsoPriceFeeding?: boolean;
};

export type CppChainRaw = {
	ruleId: string;
	sheet: string;
	block: "MAIN" | "SPARES";
	steps: CppChainStepRaw[];
	/** implied = the workbook lists none; the SCM Head does it (Monica's rule). */
	priceFeeding: { roleKey: string; implied: boolean };
	hasWf2: boolean;
};

export type CppChain = CppChainRaw & {
	/** Human band wording from cpp.rules.ts, e.g. "<10K/part, 10 L–2 Cr". */
	bandLabel: string;
	wf1: CppChainStepRaw[];
	wf2: CppChainStepRaw[];
};

/** ruleId -> band label, from the rule grids (same ids, same order). */
const bandLabels = (): Map<string, string> => {
	const map = new Map<string, string>();
	for (const def of CPP_CONDITIONS_DEF) {
		def.grid.forEach((cell, index) => {
			map.set(`${def.ruleIdPrefix}-M-${String(index + 1).padStart(2, "0")}`, cell.label);
		});
		const spare = def.spareGrid ?? def.grid;
		if (def.hasSpareBlock)
			spare.forEach((cell, index) => {
				map.set(`${def.ruleIdPrefix}-S-${String(index + 1).padStart(2, "0")}`, cell.label);
			});
	}
	return map;
};

export const CPP_CHAINS: CppChain[] = (() => {
	const labels = bandLabels();
	return CPP_CHAINS_RAW.map((chain) => ({
		...chain,
		bandLabel: labels.get(chain.ruleId) ?? chain.ruleId,
		wf1: chain.steps.filter((step) => step.stage === "WF1"),
		wf2: chain.steps.filter((step) => step.stage === "WF2"),
	}));
})();

export const getChain = (ruleId: string): CppChain | undefined =>
	CPP_CHAINS.find((chain) => chain.ruleId === ruleId);

/** Every role a chain can use, including category variants and price feeding. */
export const rolesInChain = (chain: CppChainRaw): string[] => {
	const keys = new Set<string>();
	for (const step of chain.steps) {
		step.roleKeys.forEach((key) => keys.add(key));
		if (step.variants) Object.values(step.variants).forEach((key) => keys.add(key));
	}
	keys.add(chain.priceFeeding.roleKey);
	return [...keys];
};

/** role -> number of bands that use it (shown in the admin screen). */
export const roleUsage = (): Map<string, number> => {
	const usage = new Map<string, number>();
	for (const chain of CPP_CHAINS)
		for (const key of rolesInChain(chain)) usage.set(key, (usage.get(key) ?? 0) + 1);
	return usage;
};

/** Sanity check used by the tests and the admin screen. */
export const chainProblems = (): string[] => {
	const problems: string[] = [];
	for (const chain of CPP_CHAINS) {
		for (const key of rolesInChain(chain))
			if (!getRole(key)) problems.push(`${chain.ruleId}: unknown role ${key}`);
		if (chain.steps[0]?.kind !== "PROPOSER")
			problems.push(`${chain.ruleId}: first step is not the proposer`);
		if (chain.hasWf2 && chain.wf2.length === 0)
			problems.push(`${chain.ruleId}: WF2 flagged but empty`);
	}
	return problems;
};

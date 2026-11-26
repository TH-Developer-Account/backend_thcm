// import {
// 	CPP_CHAINS,
// 	CPP_CONDITIONS_DEF,
// 	chainProblems,
// 	getChain,
// 	listAllCombinations,
// 	resolveCombination,
// 	roleUsage,
// } from "./cpp.rules";
// import {
// 	type SlotMap,
// 	approvalBandsOf,
// 	assertValidCombination,
// 	buildCppData,
// 	completenessProblems,
// 	computeCoverage,
// 	defaultSectionData,
// 	deriveBandColumns,
// 	newCoverageErrors,
// 	parseDecimal,
// 	parseSlotUpdates,
// 	planReplaceUser,
// 	resolveCppPendingOn,
// 	rowsToSlotMap,
// 	sanitizeSection,
// 	sapReferenceOf,
// 	summaryPlantProblems,
// 	toSectionList,
// } from "./cpp.helper";
// import {
// 	ASSIGNABLE_ROLES,
// 	plantCodeOf,
// 	purchaseOrgForPlant,
// 	scopesForRole,
// 	slotKey,
// } from "./cpp.constants";
// import { buildCppApprovalPlan, planInputOf } from "./cpp.workflow";

// /* ===== rules.spec ===== */
// {
// // Runs under Jest or Vitest (globals). Pins the workbook numbers so a rule edit
// // that changes the matrix is caught.

// describe("cpp.rules", () => {
// 	const all = listAllCombinations();
// 	const valid = all.filter((r) => r.result.ok);

// 	it("has the 71 rule rows of the workbook", () => {
// 		const rows = CPP_CONDITIONS_DEF.reduce(
// 			(n, d) => n + d.grid.length + (d.hasSpareBlock ? (d.spareGrid ?? d.grid).length : 0),
// 			0,
// 		);
// 		expect(rows).toBe(71);
// 	});

// 	it("has 111 valid combinations out of 270", () => {
// 		expect(all).toHaveLength(270);
// 		expect(valid).toHaveLength(111);
// 	});

// 	it("keeps direct and indirect apart", () => {
// 		expect(resolveCombination({ category: "Indirect", plant: "KGP", condition: "PRICE_CHANGE" }).ok).toBe(false);
// 		expect(resolveCombination({ category: "CFM", plant: "KGP", condition: "CRUDE_OIL" }).ok).toBe(false);
// 	});

// 	it("steel only uses the steel sheet; Spares falls back to its Main block", () => {
// 		expect(resolveCombination({ category: "STEEL", plant: "KGP", condition: "STEEL_COMMODITY" }).ok).toBe(true);
// 		expect(resolveCombination({ category: "STEEL", plant: "Spares", condition: "STEEL_COMMODITY" })).toMatchObject({ ok: true, block: "MAIN", isSpare: true });
// 		expect(resolveCombination({ category: "CFM", plant: "KGP", condition: "STEEL_COMMODITY" }).ok).toBe(false);
// 	});

// 	it("derives the spares flow from category or plant", () => {
// 		const a = resolveCombination({ category: "SPARES", plant: "DWD", condition: "PRICE_CHANGE" });
// 		const b = resolveCombination({ category: "CFM", plant: "Spares", condition: "PRICE_CHANGE" });
// 		const c = resolveCombination({ category: "CFM", plant: "DWD", condition: "PRICE_CHANGE" });
// 		expect(a.ok && a.block).toBe("SPARES");
// 		expect(b.ok && b.block).toBe("SPARES");
// 		expect(c.ok && c.block).toBe("MAIN");
// 	});

// 	it("routes plant = Spares to the KGP seats (interim, Q28) and warns about it", () => {
// 		const r = resolveCombination({ category: "CFM", plant: "Spares", condition: "FIRST_TIME_REGULAR" });
// 		expect(r.ok && r.plantSlot).toBe("KGP");
// 		expect(r.ok && r.warnings.length).toBeGreaterThan(0);
// 	});

// 	it("attaches the DOMP / Import NON HCM notes only to their categories", () => {
// 		const domp = resolveCombination({ category: "DOMP", plant: "KGP", condition: "FIRST_TIME_REGULAR" });
// 		const cfm = resolveCombination({ category: "CFM", plant: "KGP", condition: "FIRST_TIME_REGULAR" });
// 		const imp = resolveCombination({ category: "IMPORT_NON_HCM", plant: "KGP", condition: "PRICE_CHANGE" });
// 		expect(domp.ok && domp.notes).toContain("N_DOMP_SKIP");
// 		expect(cfm.ok && cfm.notes).not.toContain("N_DOMP_SKIP");
// 		expect(imp.ok && imp.notes).toContain("N_IMPORT_NON_HCM");
// 	});

// 	it("has no overlapping or gapped bands except the known crude-oil spares gap", () => {
// 		for (const def of CPP_CONDITIONS_DEF) {
// 			for (const grid of [def.grid, def.spareGrid].filter(Boolean)) {
// 				const byPart = new Map<string, { gt: number; lte: number }[]>();
// 				for (const c of grid!) {
// 					const key = JSON.stringify(c.part ?? {});
// 					byPart.set(key, [...(byPart.get(key) ?? []), { gt: c.amount.gt ?? 0, lte: c.amount.lte ?? Infinity }]);
// 				}
// 				for (const bands of byPart.values()) {
// 					bands.sort((x, y) => x.gt - y.gt);
// 					for (let i = 1; i < bands.length; i++) {
// 						const gap = bands[i]!.gt !== bands[i - 1]!.lte;
// 						const isCrudeSpares = def.code === "CRUDE_OIL" && grid === def.spareGrid;
// 						if (gap) expect(isCrudeSpares).toBe(true);
// 					}
// 				}
// 			}
// 		}
// 	});
// });
// }

// /* ===== helper.spec ===== */
// {
// const purchasing = (partValue: string, variationPct: string, amount: string, name = "Acme") => ({
// 	key: "purchasing",
// 	data: {
// 		suppliers: { recommended: { name, code: "S-1" } },
// 		approvalValues: { partValue, variationPct, amount },
// 	},
// });

// describe("cpp.helper", () => {
// 	it("parses form numbers", () => {
// 		expect(parseDecimal("12,50,000.50", "x")).toBe("1250000.50");
// 		expect(parseDecimal("", "x")).toBeNull();
// 		expect(() => parseDecimal("abc", "x")).toThrow();
// 	});

// 	it("fills only the column the condition reads", () => {
// 		const cols = deriveBandColumns("PRICE_CHANGE", { variationPct: "12.5", amount: "900000", partValue: "5" });
// 		expect(cols.maxVariationPct).toBe("12.5");
// 		expect(cols.annualisedImpact).toBe("900000");
// 		expect(cols.maxPartValue).toBeNull();
// 		expect(cols.annualisedValue).toBeNull();
// 	});

// 	it("derives listing + band columns from the sections", () => {
// 		const data = buildCppData({
// 			category: "CFM",
// 			plant: "KGP",
// 			condition: "FIRST_TIME_REGULAR",
// 			sections: [{ key: "basic", data: { reason: "Supplier price revision" } }, purchasing("4,546", "", "564566")],
// 		}) as Record<string, unknown>;
// 		expect(data.reasonCode).toBe("Supplier price revision");
// 		expect(data.supplierName).toBe("Acme");
// 		expect(data.supplierCode).toBe("S-1");
// 		expect(data.maxPartValue).toBe("4546");
// 		expect(data.annualisedValue).toBe("564566");
// 		expect(data.isSpare).toBe(false);
// 		expect(Array.isArray(data.sections)).toBe(true);
// 	});

// 	it("re-derives the columns when the condition changes", () => {
// 		const stored = {
// 			category: "CFM",
// 			plant: "KGP",
// 			condition: "PRICE_CHANGE",
// 			sections: [{ key: "purchasing", label: "x", data: { approvalValues: { variationPct: "12", amount: "500000" } } }],
// 		};
// 		const data = buildCppData({ condition: "FIRST_TIME_REGULAR" }, stored) as Record<string, unknown>;
// 		expect(data.annualisedValue).toBe("500000");
// 		expect(data.annualisedImpact).toBeNull();
// 	});

// 	it("merges sections by key: a second save keeps the other tabs", () => {
// 		const first = buildCppData({ sections: [{ key: "other", data: { remarks: "keep me" } }] }) as { sections: unknown };
// 		const second = buildCppData(
// 			{ sections: [{ key: "basic", data: { reason: "R" } }] },
// 			{ category: null, plant: null, condition: null, sections: first.sections },
// 		) as { sections: Array<{ key: string; data: Record<string, unknown> }> };
// 		expect(second.sections.find((s) => s.key === "other")?.data.remarks).toBe("keep me");
// 		expect(second.sections.find((s) => s.key === "basic")?.data.reason).toBe("R");
// 	});

// 	it("leaves untouched what the body does not mention", () => {
// 		expect(Object.keys(buildCppData({ plant: "KGP" }) as object)).toEqual(["plant", "isSpare"]);
// 	});

// 	it("rejects impossible combinations but allows partial drafts", () => {
// 		expect(() => assertValidCombination({ category: "STEEL", plant: "KGP", condition: "PRICE_CHANGE" })).toThrow();
// 		expect(() => assertValidCombination({ category: "CFM", plant: null, condition: null })).not.toThrow();
// 		expect(() => buildCppData({ category: "Indirect", condition: "PRICE_CHANGE" })).toThrow();
// 	});

// 	it("derives the spares flag", () => {
// 		const data = buildCppData({ category: "CFM", plant: "Spares" }) as Record<string, unknown>;
// 		expect(data.isSpare).toBe(true);
// 	});

// 	it("rejects unknown enum values and unknown sections", () => {
// 		expect(() => buildCppData({ plant: "NGP" })).toThrow();
// 		expect(() => buildCppData({ sections: [{ key: "basic", data: { effects: ["Speed"] } }] })).toThrow();
// 		expect(() => buildCppData({ sections: [{ key: "files", data: {} }] })).toThrow();
// 		expect(() => buildCppData({ sections: [{ key: "other", data: {} }, { key: "other", data: {} }] })).toThrow();
// 	});
// });
// }

// /* ===== sections.spec ===== */
// {
// describe("cpp.sections", () => {
// 	it("an empty section has every field", () => {
// 		const other = defaultSectionData("other") as {
// 			remarks: string;
// 			checklist: Record<string, string>;
// 			plantPrices: unknown[];
// 		};
// 		expect(other.remarks).toBe("");
// 		expect(Object.values(other.checklist).every((v) => v === "")).toBe(true);
// 		expect(other.plantPrices).toEqual([]);
// 		const basic = defaultSectionData("basic") as { workflow: { models: string[] } };
// 		expect(basic.workflow.models).toEqual([]);
// 		expect(defaultSectionData("amortisation")).toEqual({ rows: [] });
// 		const volumes = defaultSectionData("volumes") as {
// 			volumes: Record<string, unknown>;
// 			perMachineImpact: unknown[];
// 			costTracker: unknown[];
// 		};
// 		expect(volumes.volumes.DWD).toEqual({ received: "", remaining: "", annual: "" });
// 		expect(volumes.perMachineImpact).toEqual([]);
// 		expect(volumes.costTracker).toEqual([]);
// 		expect((defaultSectionData("master") as { plantDetails: unknown[] }).plantDetails).toEqual([]);
// 	});

// 	it("drops unknown keys and trims text", () => {
// 		const out = sanitizeSection("other", { remarks: "  hi  ", hack: "x" });
// 		expect(out.remarks).toBe("hi");
// 		expect(out).not.toHaveProperty("hack");
// 	});

// 	it("never stores file data from the client", () => {
// 		const out = sanitizeSection("purchasing", { purchasingFile: { url: "blob:x", file: {} }, suppliers: {} });
// 		expect(JSON.stringify(out)).not.toContain("blob:");
// 	});

// 	it("cleans numbers and rejects junk", () => {
// 		const out = sanitizeSection("purchasing", { approvalValues: { amount: "5,64,566" } }) as {
// 			approvalValues: { amount: string };
// 		};
// 		expect(out.approvalValues.amount).toBe("564566");
// 		expect(() => sanitizeSection("purchasing", { approvalValues: { amount: "abc" } })).toThrow();
// 	});

// 	it("cleans table rows: every field present, unknown keys dropped, numbers checked", () => {
// 		const out = sanitizeSection("amortisation", {
// 			rows: [{ partNo: " P1 ", priceInclAmort: "1,100", amortQty: "500", hack: "x" }],
// 		}) as { rows: Record<string, string>[] };
// 		expect(out.rows).toEqual([
// 			{ partNo: "P1", priceInclAmort: "1100", cutoffDate: "", amortQty: "500", priceAfterAmort: "" },
// 		]);
// 		expect(() => sanitizeSection("amortisation", { rows: [{ amortQty: "lots" }] })).toThrow();
// 		expect(() => sanitizeSection("amortisation", { rows: "P1" })).toThrow();
// 		expect(() => sanitizeSection("amortisation", { rows: ["P1"] })).toThrow();
// 		expect(() =>
// 			sanitizeSection("volumes", { costTracker: Array.from({ length: 21 }, () => ({})) }),
// 		).toThrow();
// 	});

// 	it("keeps which summary-sheet part an approval value came from", () => {
// 		const out = sanitizeSection("purchasing", {
// 			approvalValues: { partValue: "4546", partValuePart: " SPARE::TC02959 ", amountPart: "" },
// 		}) as { approvalValues: Record<string, string> };
// 		expect(out.approvalValues.partValuePart).toBe("SPARE::TC02959");
// 		expect(out.approvalValues.amountPart).toBe("");
// 	});

// 	it("only accepts the five SAP plant codes", () => {
// 		const out = sanitizeSection("master", {
// 			plantDetails: [{ code: "8580", name: "DWD WH", group: "SPARE", purchasingGroup: "S01", pfPct: "2" }],
// 		}) as { plantDetails: Record<string, string>[] };
// 		expect(out.plantDetails[0]).toMatchObject({ code: "8580", group: "SPARE", purchasingGroup: "S01", pfPct: "2", storeLocation: "" });
// 		expect(() => sanitizeSection("master", { plantDetails: [{ code: "9999", group: "PLANT" }] })).toThrow();
// 	});

// 	it("always returns every section in tab order", () => {
// 		expect(toSectionList({}).map((s) => s.key)).toEqual([
// 			"basic",
// 			"purchasing",
// 			"amortisation",
// 			"volumes",
// 			"financial",
// 			"master",
// 			"other",
// 		]);
// 	});
// });
// }

// /* ===== chains.spec ===== */
// {
// describe("cpp.chains", () => {
// 	it("has one chain per rule row (71) and no problems", () => {
// 		expect(CPP_CHAINS).toHaveLength(71);
// 		expect(chainProblems()).toEqual([]);
// 		const ids = new Set(CPP_CHAINS.map((c) => c.ruleId));
// 		for (const def of CPP_CONDITIONS_DEF)
// 			def.grid.forEach((_, i) => expect(ids.has(`${def.ruleIdPrefix}-M-${String(i + 1).padStart(2, "0")}`)).toBe(true));
// 	});

// 	it("splits a committee band into WF1 and WF2", () => {
// 		const chain = getChain("FTR-M-02");
// 		expect(chain?.wf1.map((s) => s.kind)).toEqual(["PROPOSER", "RECOMMENDER", "RECOMMENDER", "CHECKER", "APPROVER", "APPROVER"]);
// 		expect(chain?.wf2[0]).toMatchObject({ kind: "COMMITTEE", required: 3 });
// 		expect(chain?.wf2).toHaveLength(2);
// 		expect(chain?.wf2[1]).toMatchObject({ mode: "ANY_ONE", roleKeys: ["ALT_CHAIRMAN", "CHAIRMAN"] });
// 	});

// 	it("lowest bands are a single workflow", () => {
// 		const chain = getChain("FTR-M-01");
// 		expect(chain?.hasWf2).toBe(false);
// 		expect(chain?.wf2).toHaveLength(0);
// 		expect(chain?.priceFeeding).toEqual({ roleKey: "SCM_HEAD", implied: true });
// 	});

// 	it("MD above 25 L on crude oil is reporting, not an approval", () => {
// 		const step = getChain("CRU-M-02")?.steps.find((s) => s.roleKeys[0] === "MD_THCM");
// 		expect(step?.kind).toBe("REPORTING");
// 	});

// 	it("every role a chain uses exists, and SCM Head is the busiest", () => {
// 		const usage = roleUsage();
// 		expect(usage.get("SCM_HEAD")).toBeGreaterThan(60);
// 		expect(usage.get("COMMITTEE_7")).toBe(48);
// 	});
// });
// }

// /* ===== matrix.helper.spec ===== */
// {
// const full = (): SlotMap => {
// 	const map: SlotMap = new Map();
// 	const usage = roleUsage();
// 	for (const role of ASSIGNABLE_ROLES)
// 		if ((usage.get(role.key) ?? 0) > 0 || role.key.startsWith("COMMITTEE"))
// 			for (const scope of scopesForRole(role)) map.set(slotKey(role.key, scope), ["u1"]);
// 	return map;
// };

// describe("cpp.matrix.helper", () => {
// 	it("an empty matrix lists every needed slot as an error", () => {
// 		const errors = computeCoverage(new Map()).filter((i) => i.severity === "error");
// 		expect(errors.length).toBeGreaterThan(15);
// 	});

// 	it("a fully assigned matrix has no errors", () => {
// 		expect(computeCoverage(full()).filter((i) => i.severity === "error")).toEqual([]);
// 	});

// 	it("blocks a save that empties a slot, but not one that was already empty", () => {
// 		const before = full();
// 		const after = new Map(before).set(slotKey("SCM_HEAD", "ALL"), []);
// 		expect(newCoverageErrors(before, after)).toHaveLength(1);
// 		expect(newCoverageErrors(new Map(), new Map())).toEqual([]);
// 	});

// 	it("needs at least 3 committee members", () => {
// 		const map = full();
// 		for (const n of [3, 4, 5, 6, 7]) map.set(slotKey(`COMMITTEE_${n}`, "ALL"), []);
// 		expect(computeCoverage(map).some((i) => i.severity === "error" && i.roleKey === "COMMITTEE_1")).toBe(true);
// 	});

// 	it("validates the save body", () => {
// 		expect(() => parseSlotUpdates([{ roleKey: "SCM_HEAD", scope: "KGP", userIds: ["a"] }])).toThrow();
// 		expect(() => parseSlotUpdates([{ roleKey: "A_C_MANAGER", scope: "ALL", userIds: ["a"] }])).toThrow();
// 		expect(parseSlotUpdates([{ roleKey: "HEAD_SCM", scope: "KGP", userIds: ["a", "a"] }])[0].userIds).toEqual(["a"]);
// 	});

// 	it("replace user everywhere handles a person already in the slot", () => {
// 		const rows = [
// 			{ id: "1", roleKey: "SCM_HEAD", scope: "ALL", userId: "old" },
// 			{ id: "2", roleKey: "CHAIRMAN", scope: "ALL", userId: "old" },
// 			{ id: "3", roleKey: "CHAIRMAN", scope: "ALL", userId: "new" },
// 		];
// 		expect(planReplaceUser(rows, "old", "new")).toEqual({ updates: ["1"], deletes: ["2"] });
// 		expect(rowsToSlotMap(rows).get(slotKey("CHAIRMAN", "ALL"))).toEqual(["old", "new"]);
// 	});
// });
// }

// /* ===== pending on ===== */
// {
// describe("resolveCppPendingOn", () => {
// 	const approvers = { role: "APPROVER" as const, approvers: [{ id: "u1", name: "Test User" }] };

// 	it("waits on the proposer for a draft or a clarification", () => {
// 		expect(resolveCppPendingOn("DRAFT", undefined)).toEqual({ role: "PROPOSER" });
// 		expect(resolveCppPendingOn("CLARIFICATION_REQUESTED", approvers)).toEqual({ role: "PROPOSER" });
// 	});

// 	it("uses the workflow while in approval or price feeding", () => {
// 		expect(resolveCppPendingOn("IN_PROGRESS", approvers)).toBe(approvers);
// 		expect(resolveCppPendingOn("PRICE_FEEDING", approvers)).toBe(approvers);
// 	});

// 	it("waits on nobody once completed", () => {
// 		expect(resolveCppPendingOn("COMPLETED", approvers)).toEqual({ role: "NONE", outcome: "APPROVED" });
// 	});
// });
// }

// /* ===== SAP plants / purchasing org ===== */
// {
// describe("cpp SAP plant data", () => {
// 	it("maps summary-sheet plant names to SAP codes", () => {
// 		expect(plantCodeOf("dwd")).toBe("1006");
// 		expect(plantCodeOf(" KGP  WH ")).toBe("8445");
// 		expect(plantCodeOf("8400")).toBe("8400");
// 		expect(plantCodeOf("Pune")).toBeNull();
// 	});

// 	it("uses P506 for plant 8400 and P501 for every other plant", () => {
// 		expect(purchaseOrgForPlant("8400")).toBe("P506");
// 		for (const code of ["1006", "3006", "8445", "8580"]) expect(purchaseOrgForPlant(code)).toBe("P501");
// 	});

// 	it("keeps only the number of the reference for SAP", () => {
// 		expect(sapReferenceOf("WS191126154912347")).toBe("191126154912347");
// 	});
// });
// }

// /* ===== submit checks ===== */
// {
// const routingRow = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
// 	category: "CFM",
// 	plant: "KGP",
// 	condition: "FIRST_TIME_REGULAR",
// 	sections,
// 	maxPartValue: null,
// 	maxVariationPct: null,
// 	annualisedValue: null,
// 	annualisedImpact: null,
// 	actualImpact: null,
// 	...extra,
// });

// describe("cpp submit checks", () => {
// 	it("keeps the picked approval ranges when saving (they used to be dropped)", () => {
// 		const out = sanitizeSection("purchasing", {
// 			approvalValues: { partBand: "_10000", amountBand: "1000000_20000000" },
// 		}) as { approvalValues: Record<string, string> };
// 		expect(out.approvalValues.partBand).toBe("_10000");
// 		expect(out.approvalValues.amountBand).toBe("1000000_20000000");
// 		expect(approvalBandsOf([{ key: "purchasing", data: out }])).toEqual({
// 			partBand: "_10000",
// 			amountBand: "1000000_20000000",
// 		});
// 	});

// 	it("routes on the picked ranges", () => {
// 		const sections = [{ key: "purchasing", data: { approvalValues: { partBand: "_10000", amountBand: "1000000_20000000" } } }];
// 		const plan = buildCppApprovalPlan(planInputOf(routingRow(sections), new Map()));
// 		// Empty matrix, so it fails on people, but only after picking FTR-M-02's chain.
// 		expect(plan.ok).toBe(false);
// 		expect(!plan.ok && plan.problems.join(" ")).toContain("CPP committee");
// 	});

// 	it("lists what is missing before submit", () => {
// 		const problems = completenessProblems(routingRow([]));
// 		expect(problems.join(" ")).toContain("Reason is required");
// 		expect(problems.join(" ")).toContain("vendor code");
// 		expect(problems.join(" ")).toContain("highest value per part");

// 		const ready = completenessProblems(
// 			routingRow([
// 				{ key: "basic", data: { reason: "R", justification: "J" } },
// 				{ key: "purchasing", data: { suppliers: { recommended: { name: "Acme", code: "S-1" } }, approvalValues: { partBand: "_10000", amountBand: "_1000000" } } },
// 			]),
// 		);
// 		expect(ready).toEqual([]);
// 	});

// 	it("checks summary-sheet plants against Master Data", () => {
// 		expect(summaryPlantProblems([], [])).toEqual(["Upload the summary sheet (part info) before submitting."]);
// 		const master = [{ key: "master", data: { plantDetails: [{ code: "3006", purchasingGroup: "P01", taxCode: "" }] } }];
// 		const problems = summaryPlantProblems(
// 			[{ plant: "KGP" }, { plant: "DWD" }, { plant: "Pune" }],
// 			master,
// 		).join(" ");
// 		expect(problems).toContain("Pune");
// 		expect(problems).toContain("DWD (1006)");
// 		expect(problems).toContain("KGP (3006)");
// 	});
// });
// }

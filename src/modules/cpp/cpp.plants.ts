// cpp.plants.ts — one place for the summary-sheet plant names -> SAP plant codes.
// Used by the submit check (cpp.submit.controller.ts) and the text export
// (cpp.export.controller.ts), so both always agree on what a plant is.

/* ── EDIT HERE: summary-sheet plant names -> SAP plant codes ───────────────── */
export const PLANT_CODE_BY_NAME: Record<string, string> = {
	DWD: "1006",
	KGP: "3006",
	"KGP WH": "8445",
	"DWD WH": "8580",
	NGP: "8400",
};
/* ───────────────────────────────────────────────────────────────────────────── */

/** "1006" stays "1006"; "DWD" -> "1006". Null when the name is not a known plant. */
export const plantCodeOf = (value: string): string | null => {
	const v = value.trim().toUpperCase().replace(/\s+/g, " ");
	if (/^\d{4}$/.test(v)) return v;
	return PLANT_CODE_BY_NAME[v] ?? null;
};

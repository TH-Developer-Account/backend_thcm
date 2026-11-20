import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// CPP — PART ROWS PARSER
//
// A CPP request stores no line items in the database: the part-level rows live
// only in the Excel the proposer uploads (attachment type "purchasingFile").
// This reads that workbook once and hands back whatever it can recognise, so
// the PDF Summary Sheet and the Purchase-Info-Record text export share one
// parser. It NEVER throws — an unreadable or unrecognised file simply yields
// empty arrays and the callers fall back to "As per encl".
//
// Two layouts are recognised (by sheet + header text, not by cell address, so
// a shifted row or an extra column does not break it):
//   1. "Summary" sheet  (THX11-D07-F07)  → summaryRows
//   2. "Price Update" sheet (Purchase Info Record for TCS) → pirRows + pirHeader
// ─────────────────────────────────────────────────────────────────────────────

export interface CppSummaryRow {
	kind: "part";
	slNo: number | null;
	plant: string;
	model: string;
	partNo: string;
	description: string;
	uom: string;
	existingPrice: number | null;
	newPrice: number | null;
	difference: number | null;
	currentPo: string;
	effectiveDate: string;
	rcvdQty: number | null;
	actualImpact: number | null;
	abpVol: number | null;
	qtyPerMc: number | null;
	annualisedImpact: number | null;
	pctChange: number | null; // fraction, 0.059 = 5.9 %
}

export interface CppSummaryHeading {
	kind: "heading";
	text: string;
}

export type CppSummaryLine = CppSummaryRow | CppSummaryHeading;

export interface CppPirRow {
	sr: number | null;
	partNo: string;
	description: string;
	validFrom: string; // dd.mm.yyyy
	validTo: string;
	condition: string;
	price: number | null;
	needsMasterChange: string;
	plant: string;
	poForPosa: string;
}

export interface CppPirHeader {
	referenceNo: string;
	plants: string;
	supplierCode: string;
	specialNotes: string;
}

export interface CppPartRows {
	summary: CppSummaryLine[];
	pir: CppPirRow[];
	pirHeader: CppPirHeader | null;
}

export const EMPTY_PART_ROWS: CppPartRows = {
	summary: [],
	pir: [],
	pirHeader: null,
};

type Grid = unknown[][];

const norm = (v: unknown): string =>
	String(v ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const text = (v: unknown): string =>
	v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim();

const pad2 = (n: number) => String(n).padStart(2, "0");

const dateText = (v: unknown): string => {
	// Excel dates arrive as serial numbers (cellDates is off on purpose: a JS
	// Date built from a serial is shifted by the server's time zone).
	if (typeof v === "number" && v > 20000 && v < 80000) {
		const d = XLSX.SSF.parse_date_code(v);
		if (d) return `${pad2(d.d)}.${pad2(d.m)}.${d.y}`;
	}
	if (v instanceof Date && !Number.isNaN(v.getTime()))
		return `${pad2(v.getDate())}.${pad2(v.getMonth() + 1)}.${v.getFullYear()}`;
	const s = text(v);
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
	const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
	if (dmy) return `${pad2(Number(dmy[1]))}.${pad2(Number(dmy[2]))}.${dmy[3]}`;
	return s;
};

const numberOrNull = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	const s = text(v).replace(/[₹,\s]/g, "").replace(/%$/, "");
	if (s === "" || s === "-") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
};

/** Percent cells: "5.9%" (string) or 0.059 (number) both mean 5.9 %. */
const fractionOrNull = (v: unknown): number | null => {
	if (typeof v === "string" && v.trim().endsWith("%")) {
		const n = numberOrNull(v);
		return n === null ? null : n / 100;
	}
	return numberOrNull(v);
};

const toGrid = (sheet: XLSX.WorkSheet): Grid =>
	XLSX.utils.sheet_to_json<unknown[]>(sheet, {
		header: 1,
		raw: true,
		defval: "",
		blankrows: false,
	});

/** First row (within the first 40) where any cell matches the test. */
const findRow = (grid: Grid, test: (cell: string) => boolean): number => {
	for (let r = 0; r < Math.min(grid.length, 40); r += 1)
		if ((grid[r] ?? []).some((cell) => test(norm(cell)))) return r;
	return -1;
};

const findCol = (row: unknown[], test: (cell: string) => boolean): number =>
	row.findIndex((cell) => test(norm(cell)));

const hasSheet = (wb: XLSX.WorkBook, test: RegExp): string | undefined =>
	wb.SheetNames.find((n) => test.test(n));

/* ------------------------------ Summary sheet ----------------------------- */

function parseSummary(sheet: XLSX.WorkSheet): CppSummaryLine[] {
	const grid = toGrid(sheet);
	const headerRow = findRow(grid, (c) => c === "part no." || c === "part no");
	if (headerRow < 0) return [];

	// Header text can wrap over two rows (merged cells), so search both.
	const header = (grid[headerRow] ?? []).map((cell, i) =>
		[cell, grid[headerRow + 1]?.[i]].map(norm).join(" ").trim(),
	);
	const col = (test: (c: string) => boolean) => header.findIndex(test);

	const idx = {
		sl: col((c) => /^sl\.? ?no/.test(c)),
		plant: col((c) => c.startsWith("plant")),
		model: col((c) => c.startsWith("model")),
		partNo: col((c) => c.startsWith("part no")),
		description: col((c) => c.startsWith("description")),
		uom: col((c) => c.startsWith("uom")),
		existing: col((c) => c.startsWith("existing price")),
		newPrice: col((c) => c.startsWith("new price")),
		diff: col((c) => c.startsWith("difference")),
		po: col((c) => c.includes("current po")),
		eff: col((c) => c.includes("effective date")),
		rcvd: col((c) => c.startsWith("rcvd qty") || c.startsWith("received qty")),
		actual: col((c) => c.startsWith("actual impact")),
		abp: col((c) => c.startsWith("abp vol")),
		qtyMc: col((c) => c.startsWith("qty per m")),
		annual: col((c) => c.startsWith("annualised impact") || c.startsWith("annualized impact")),
		pct: col((c) => c.includes("% change")),
	};
	if (idx.partNo < 0) return [];

	// First data row: skip the second header line when it carries "(in INR)".
	let start = headerRow + 1;
	const second = (grid[start] ?? []).map(norm).join(" ");
	if (second.includes("(in inr)") && !second.match(/\d/)) start += 1;

	const get = (row: unknown[], i: number) => (i >= 0 ? row[i] : "");
	const out: CppSummaryLine[] = [];

	for (let r = start; r < grid.length; r += 1) {
		const row = grid[r] ?? [];
		const partNo = text(get(row, idx.partNo));
		const nonEmpty = row.map(text).filter(Boolean);

		// Footer (totals / signatures) starts at the first "A →" or label row.
		if (!partNo) {
			if (nonEmpty.some((c) => /^a\s*→|^landed calc|current\. change/i.test(c))) break;
			// A lone text cell (no numbers) is a group heading, e.g.
			// "Commodity Price Change Q1 FY 26-27".
			if (nonEmpty.length === 1 && Number.isNaN(Number(nonEmpty[0].replace(/,/g, ""))))
				out.push({ kind: "heading", text: nonEmpty[0] });
			continue;
		}

		const existingPrice = numberOrNull(get(row, idx.existing));
		const newPrice = numberOrNull(get(row, idx.newPrice));
		const rcvdQty = numberOrNull(get(row, idx.rcvd));
		const abpVol = numberOrNull(get(row, idx.abp));
		const qtyPerMc = numberOrNull(get(row, idx.qtyMc));

		const difference =
			numberOrNull(get(row, idx.diff)) ??
			(existingPrice !== null && newPrice !== null ? newPrice - existingPrice : null);
		const actualImpact =
			numberOrNull(get(row, idx.actual)) ??
			(difference !== null && rcvdQty !== null ? difference * rcvdQty : null);
		const annualisedImpact =
			numberOrNull(get(row, idx.annual)) ??
			(difference !== null && abpVol !== null && qtyPerMc !== null
				? difference * abpVol * qtyPerMc
				: null);
		const pctChange =
			fractionOrNull(get(row, idx.pct)) ??
			(difference !== null && existingPrice ? difference / existingPrice : null);

		out.push({
			kind: "part",
			slNo: numberOrNull(get(row, idx.sl)),
			plant: text(get(row, idx.plant)),
			model: text(get(row, idx.model)),
			partNo,
			description: text(get(row, idx.description)),
			uom: text(get(row, idx.uom)),
			existingPrice,
			newPrice,
			difference,
			currentPo: text(get(row, idx.po)),
			effectiveDate: dateText(get(row, idx.eff)),
			rcvdQty,
			actualImpact,
			abpVol,
			qtyPerMc,
			annualisedImpact,
			pctChange,
		});
	}
	return out;
}

/* --------------------------- Purchase Info Record ------------------------- */

function parsePir(sheet: XLSX.WorkSheet): {
	rows: CppPirRow[];
	header: CppPirHeader;
} {
	const grid = toGrid(sheet);
	const valueAfter = (label: RegExp): string => {
		for (const row of grid.slice(0, 12)) {
			const i = (row ?? []).findIndex((c) => label.test(norm(c)));
			if (i >= 0) {
				const v = (row ?? []).slice(i + 1).map(text).find(Boolean);
				if (v) return v;
			}
		}
		return "";
	};
	const header: CppPirHeader = {
		referenceNo: valueAfter(/^cpp reference no/),
		plants: valueAfter(/^plant\(s\)/),
		supplierCode: valueAfter(/^supplier code/),
		specialNotes: "",
	};
	for (const row of grid.slice(0, 12)) {
		const i = (row ?? []).findIndex((c) => norm(c).startsWith("special notes"));
		if (i >= 0)
			header.specialNotes = text(
				(row ?? []).slice(i).join(" ").replace(/special notes \(if any\) ?:/i, ""),
			);
	}

	const headerRow = findRow(grid, (c) => c === "part no");
	if (headerRow < 0) return { rows: [], header };
	const top = grid[headerRow] ?? [];
	const sub = grid[headerRow + 1] ?? [];

	const idx = {
		sr: findCol(top, (c) => c === "sr"),
		partNo: findCol(top, (c) => c === "part no"),
		description: findCol(top, (c) => c === "description"),
		from: findCol(sub, (c) => c === "wefrom" || c === "w.e.f" || c === "valid from"),
		to: findCol(sub, (c) => c === "upto" || c === "valid to"),
		condition: findCol(sub, (c) => c === "condition"),
		price: findCol(sub, (c) => c === "price"),
		mm: findCol(top, (c) => c.startsWith("needs material master")),
		plant: findCol(top, (c) => c === "plant"),
		po: findCol(top, (c) => c.startsWith("po for")),
	};
	if (idx.partNo < 0) return { rows: [], header };

	const rows: CppPirRow[] = [];
	for (let r = headerRow + 2; r < grid.length; r += 1) {
		const row = grid[r] ?? [];
		const partNo = text(row[idx.partNo]);
		if (!partNo) continue;
		rows.push({
			sr: numberOrNull(idx.sr >= 0 ? row[idx.sr] : ""),
			partNo,
			description: text(idx.description >= 0 ? row[idx.description] : ""),
			validFrom: dateText(idx.from >= 0 ? row[idx.from] : ""),
			validTo: dateText(idx.to >= 0 ? row[idx.to] : ""),
			condition: text(idx.condition >= 0 ? row[idx.condition] : ""),
			price: numberOrNull(idx.price >= 0 ? row[idx.price] : ""),
			needsMasterChange: text(idx.mm >= 0 ? row[idx.mm] : ""),
			plant: text(idx.plant >= 0 ? row[idx.plant] : ""),
			poForPosa: text(idx.po >= 0 ? row[idx.po] : ""),
		});
	}
	return { rows, header };
}

/* --------------------------------- public --------------------------------- */

export function parseCppPartRows(buffer: Buffer): CppPartRows {
	try {
		const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
		const result: CppPartRows = { summary: [], pir: [], pirHeader: null };

		const summaryName = hasSheet(wb, /summary/i);
		if (summaryName) result.summary = parseSummary(wb.Sheets[summaryName]);

		const pirName = hasSheet(wb, /price\s*update|info\s*record/i);
		if (pirName) {
			const { rows, header } = parsePir(wb.Sheets[pirName]);
			result.pir = rows;
			result.pirHeader = header;
		}
		return result;
	} catch {
		return { summary: [], pir: [], pirHeader: null };
	}
}

/** Sums used by the form's Financial Impact box and the Summary Sheet totals. */
export function summariseImpact(lines: CppSummaryLine[]): {
	actual: number | null;
	annual: number | null;
	actualPct: number | null;
	annualPct: number | null;
} {
	const parts = lines.filter((l): l is CppSummaryRow => l.kind === "part");
	if (parts.length === 0)
		return { actual: null, annual: null, actualPct: null, annualPct: null };

	let actual = 0;
	let annual = 0;
	let actualBase = 0;
	let annualBase = 0;
	for (const p of parts) {
		actual += p.actualImpact ?? 0;
		annual += p.annualisedImpact ?? 0;
		if (p.existingPrice !== null) {
			actualBase += p.existingPrice * (p.rcvdQty ?? 0);
			annualBase += p.existingPrice * (p.abpVol ?? 0) * (p.qtyPerMc ?? 0);
		}
	}
	return {
		actual,
		annual,
		actualPct: actualBase ? actual / actualBase : null,
		annualPct: annualBase ? annual / annualBase : null,
	};
}

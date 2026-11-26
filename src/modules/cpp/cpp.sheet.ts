// cpp.sheet.ts — every Excel file a CPP request reads or writes. Pure: no DB, no S3.
//
//   Summary sheet (part info) — the file the proposer uploads in Purchasing details
//     buildPartSummaryWorkbook(rows?)  the sheet in the expected format (locked headers)
//     buildPartSummaryTemplate()       the blank sheet as a .xlsx buffer
//     parsePartSummary(buffer)         reads the part rows; throws ApiError 422 with a
//                                      message the proposer can act on
//     readStoredPartSummary(parsed)    the rows saved on the attachment (parsedData)
//     storedSummaryLines(parsed)       the same rows, typed for the PDF
//
//   Purchasing file (legacy) — requests saved before the summary sheet existed
//     parseCppPartRows(buffer)         "Summary" + "Price Update" sheets; never throws
//
//   summariseImpact(lines)             totals for the Financial Impact box / PDF
//
// Replaces cpp.partSummary.ts and cppPartRows.ts: both had their own copy of the
// text / number / date parsers below.
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

import ApiError from "@shared/utils/apiError";

/* ── shared cell parsers ──────────────────────────────────────────────────── */

type Grid = unknown[][];

/** Lower-case, single-spaced: for matching header text. */
const norm = (value: unknown): string =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

/** Trimmed, single-spaced cell text ("" for blank). */
const text = (value: unknown): string =>
	value === null || value === undefined
		? ""
		: String(value).replace(/\s+/g, " ").trim();

const pad2 = (n: number) => String(n).padStart(2, "0");

/** null = blank, undefined = not a number. Strips ₹, commas, spaces and a trailing %. */
const toNumber = (value: unknown): number | null | undefined => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	const cleaned = String(value)
		.replace(/[₹,\s]/g, "")
		.replace(/%$/, "");
	if (cleaned === "" || cleaned === "-") return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : undefined;
};

/** Lenient variant for the legacy file: anything unreadable is blank. */
const numberOrNull = (value: unknown): number | null => toNumber(value) ?? null;

/** Percent cells: "5.9%" (string) or 0.059 (number) both mean 5.9 %. */
const fractionOrNull = (value: unknown): number | null => {
	if (typeof value === "string" && value.trim().endsWith("%")) {
		const n = numberOrNull(value);
		return n === null ? null : n / 100;
	}
	return numberOrNull(value);
};

/**
 * Any date cell -> dd.mm.yyyy (the SAP text files strip the dots).
 * Excel serials are read with cellDates off on purpose: a JS Date built from a
 * serial is shifted by the server's time zone. Unrecognised text is kept as is.
 */
const dateText = (value: unknown): string => {
	if (typeof value === "number" && value > 20000 && value < 80000) {
		const d = XLSX.SSF.parse_date_code(value);
		if (d) return `${pad2(d.d)}.${pad2(d.m)}.${d.y}`;
	}
	if (value instanceof Date && !Number.isNaN(value.getTime()))
		return `${pad2(value.getDate())}.${pad2(value.getMonth() + 1)}.${value.getFullYear()}`;
	const s = text(value);
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
	const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
	if (dmy) return `${pad2(Number(dmy[1]))}.${pad2(Number(dmy[2]))}.${dmy[3]}`;
	return s;
};

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const readFirstSheetGrid = (buffer: Buffer, blankrows: boolean): Grid => {
	const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
	const first = wb.SheetNames[0];
	if (!first) throw new Error("no sheet");
	return toGrid(wb.Sheets[first], blankrows);
};

const toGrid = (sheet: XLSX.WorkSheet, blankrows = false): Grid =>
	XLSX.utils.sheet_to_json<unknown[]>(sheet, {
		header: 1,
		raw: true,
		defval: "",
		blankrows,
	});

/* ── summary sheet: layout ────────────────────────────────────────────────── */

export const PART_SUMMARY_MAX_ROWS = 2000;

/* Layout of the sheet: group row, header row, then data. */
const GROUP_ROW = 1;
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 3;

type PartSummaryColumn = {
	key: string;
	group: string;
	header: string;
	/** Tests the normalised (lower-case, single-space) header text. */
	test: (header: string) => boolean;
	number: boolean;
};

const PRICE_REVISION = "Price Revision Data";
const RETRO = "For Retro. Price Impact";
const ANNUALISED = "For Annualised Impact";

const eq = (t: string) => (h: string) => h === t;
const starts = (t: string) => (h: string) => h.startsWith(t);
const has = (t: string) => (h: string) => h.includes(t);

/** Same columns, in the same order, as the format shown in the Purchasing details modal. */
export const PART_SUMMARY_COLUMNS: PartSummaryColumn[] = [
	{ key: "slNo", group: PRICE_REVISION, header: "Sl. No.", test: (h) => /^sl\.?\s*no/.test(h), number: true },
	{ key: "plant", group: PRICE_REVISION, header: "Plant", test: eq("plant"), number: false },
	{ key: "model", group: PRICE_REVISION, header: "Model", test: eq("model"), number: false },
	{ key: "partNo", group: PRICE_REVISION, header: "Part No.", test: starts("part no"), number: false },
	{ key: "description", group: PRICE_REVISION, header: "Description", test: eq("description"), number: false },
	{ key: "uom", group: PRICE_REVISION, header: "UOM", test: eq("uom"), number: false },
	{ key: "existingPrice", group: PRICE_REVISION, header: "Existing Price w.e.f.01.01.26 (INR)", test: starts("existing price"), number: true },
	{ key: "newPrice", group: PRICE_REVISION, header: "New Price (INR)", test: starts("new price"), number: true },
	{ key: "difference", group: PRICE_REVISION, header: "Difference (INR)", test: starts("difference"), number: true },
	{ key: "currentPo", group: PRICE_REVISION, header: "Current PO applicable for PO/SA updation", test: has("current po"), number: false },
	{ key: "effectiveDate", group: PRICE_REVISION, header: "Effective Date", test: has("effective date"), number: false },
	{ key: "rcvdQty", group: RETRO, header: "Rcvd Qty", test: starts("rcvd qty"), number: true },
	{ key: "actualImpact", group: RETRO, header: "Actual Impact", test: starts("actual impact"), number: true },
	{ key: "abpVol", group: ANNUALISED, header: "ABP Vol.", test: starts("abp vol"), number: true },
	{ key: "qtyPerMc", group: ANNUALISED, header: "Qty per m/c", test: starts("qty per m"), number: true },
	{ key: "annualisedImpact", group: ANNUALISED, header: "Annualised Impact", test: starts("annualised impact"), number: true },
	{ key: "pctChange", group: ANNUALISED, header: "% Change", test: has("% change"), number: true },
];

export type PartSummaryRow = Record<string, string | number | null>;
export type PartSummaryData = { columns: string[]; rows: PartSummaryRow[] };

/* ── summary sheet: write ─────────────────────────────────────────────────── */

/**
 * The summary sheet in the expected format.
 *   - Header rows (group row and header row): locked, bold.
 *   - Every column is open for typing below the header, so the data cells are editable.
 *   - Sheet is protected: columns cannot be inserted or deleted. Rows can still be added or removed.
 * insertColumns / deleteColumns are left out on purpose. The OOXML default for them is "locked";
 * passing `true` to ExcelJS would write "0", which unlocks them.
 * `rows` fills the data area (used by the export). Empty for the blank template.
 */
export const buildPartSummaryWorkbook = async (
	rows: PartSummaryRow[] = [],
): Promise<ExcelJS.Workbook> => {
	const columns = PART_SUMMARY_COLUMNS;
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("Summary");

	// Column style: open. Header rows are set to locked below, so only data cells are editable.
	columns.forEach((_, i) => {
		const col = ws.getColumn(i + 1);
		col.width = 16;
		col.protection = { locked: false };
	});

	// Group row, merged across the columns of each group.
	const groups: Array<{ name: string; from: number; to: number }> = [];
	columns.forEach((column, i) => {
		const last = groups[groups.length - 1];
		if (last && last.name === column.group) last.to = i;
		else groups.push({ name: column.group, from: i, to: i });
	});
	for (const group of groups) {
		ws.getCell(GROUP_ROW, group.from + 1).value = group.name;
		if (group.to > group.from)
			ws.mergeCells(GROUP_ROW, group.from + 1, GROUP_ROW, group.to + 1);
	}

	columns.forEach((column, i) => {
		ws.getCell(HEADER_ROW, i + 1).value = column.header;
	});

	for (let c = 1; c <= columns.length; c++) {
		for (const r of [GROUP_ROW, HEADER_ROW]) {
			const cell = ws.getCell(r, c);
			cell.protection = { locked: true };
			cell.font = { bold: true };
			cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
		}
	}

	rows.forEach((row, r) => {
		columns.forEach((column, i) => {
			const value = row[column.key];
			if (value !== null && value !== undefined)
				ws.getCell(FIRST_DATA_ROW + r, i + 1).value = value;
		});
	});

	ws.protect("", {
		insertRows: true, // true = allowed (written as "0")
		deleteRows: true,
		selectLockedCells: true,
		selectUnlockedCells: true,
	});

	return wb;
};

/** Blank sheet in the expected format, as a .xlsx buffer. */
export const buildPartSummaryTemplate = async (): Promise<Buffer> => {
	const wb = await buildPartSummaryWorkbook();
	return Buffer.from(await wb.xlsx.writeBuffer());
};

/** The given rows in the template layout, as a .xlsx buffer (the Excel export). */
export const buildPartSummaryBuffer = async (
	rows: PartSummaryRow[],
): Promise<Buffer> => {
	const wb = await buildPartSummaryWorkbook(rows);
	return Buffer.from(await wb.xlsx.writeBuffer());
};

/* ── summary sheet: read ──────────────────────────────────────────────────── */

/**
 * Reads the part rows from the first sheet. Throws ApiError(422) when the sheet does not fit.
 * Columns are matched by header text, so their order does not matter. Each expected column
 * must appear exactly once, and no other column may be added. Sheet protection stops this in
 * Excel; this parser is the real check, because a protected sheet can be unprotected.
 */
export const parsePartSummary = (buffer: Buffer): PartSummaryData => {
	const invalid = (message: string) => new ApiError(422, message);

	let grid: Grid;
	try {
		grid = readFirstSheetGrid(buffer, true);
	} catch {
		throw invalid(
			"The summary sheet could not be read. Upload the Excel (.xlsx) in the expected format.",
		);
	}

	const headerIndex = grid
		.slice(0, 40)
		.findIndex((row) => (row ?? []).some((cell) => norm(cell).startsWith("part no")));
	if (headerIndex < 0)
		throw invalid(
			'The summary sheet has no "Part No." header row. Keep the header and sub-header rows from the template.',
		);

	const headerCells = (grid[headerIndex] ?? []) as unknown[];
	const header = headerCells.map(norm);

	// Each expected column must be present exactly once.
	const columnAt = new Map<string, number>();
	const missing: string[] = [];
	const duplicated: string[] = [];
	for (const column of PART_SUMMARY_COLUMNS) {
		const hits = header.flatMap((h, i) => (h && column.test(h) ? [i] : []));
		if (hits.length === 0) missing.push(column.header);
		else if (hits.length > 1) duplicated.push(column.header);
		else columnAt.set(column.key, hits[0]);
	}
	if (missing.length)
		throw invalid(
			`The summary sheet is missing column(s): ${missing.join(", ")}. Use the expected format and do not rename or remove columns.`,
		);
	if (duplicated.length)
		throw invalid(
			`The summary sheet has more than one column called: ${duplicated.join(", ")}. Keep each column once.`,
		);

	// Any other header text is a column that was added.
	const expectedIndexes = new Set(columnAt.values());
	const added = headerCells
		.map(text)
		.filter((label, i) => label !== "" && !expectedIndexes.has(i));
	if (added.length)
		throw invalid(
			`The summary sheet has added column(s): ${added.join(", ")}. Do not add columns; use the template.`,
		);

	const rows: PartSummaryRow[] = [];
	for (let r = headerIndex + 1; r < grid.length; r += 1) {
		const row = grid[r] ?? [];
		const cells = row.map(text);
		if (cells.every((cell) => cell === "")) continue;
		// The totals ("A →", "B →") end the part table.
		const firstText = cells.find((cell) => cell !== "") ?? "";
		if (/^[AB]\s*→|^total/i.test(firstText)) break;

		const excelRow = r + 1;
		// Data in a column with no expected header (e.g. after an unprotect) is rejected.
		const stray = row.findIndex((cell, i) => text(cell) !== "" && !expectedIndexes.has(i));
		if (stray >= 0)
			throw invalid(
				`Row ${excelRow}: data in column ${stray + 1}, which is not part of the expected format. Do not add columns.`,
			);

		const at = (key: string) => row[columnAt.get(key) ?? -1];
		if (!text(at("partNo"))) throw invalid(`Row ${excelRow}: Part No. is missing.`);
		if (!text(at("plant"))) throw invalid(`Row ${excelRow}: Plant is missing.`);

		const record: PartSummaryRow = {};
		for (const column of PART_SUMMARY_COLUMNS) {
			const raw = at(column.key);
			if (column.number) {
				const n = toNumber(raw);
				if (n === undefined)
					throw invalid(`Row ${excelRow}: "${column.header}" must be a number.`);
				record[column.key] = n;
			} else if (column.key === "effectiveDate") {
				record[column.key] = dateText(raw);
			} else {
				record[column.key] = text(raw);
			}
		}
		rows.push(record);
		if (rows.length > PART_SUMMARY_MAX_ROWS)
			throw invalid(`The summary sheet has more than ${PART_SUMMARY_MAX_ROWS} part rows.`);
	}

	if (rows.length === 0)
		throw invalid(
			"No part rows were found. Fill the data rows below the sub-header, then upload again.",
		);
	return { columns: PART_SUMMARY_COLUMNS.map((c) => c.key), rows };
};

/* ── summary sheet: what was saved at upload ──────────────────────────────── */

/**
 * The rows saved on the "partSummary" attachment (its parsedData), [] when none.
 * One reader for the detail response, the submit check, the exports and the PDF.
 */
export const readStoredPartSummary = (parsed: unknown): PartSummaryRow[] => {
	const rows = asRecord(parsed).rows;
	return Array.isArray(rows) ? (rows as PartSummaryRow[]) : [];
};

/* ── PDF part lines ───────────────────────────────────────────────────────── */

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

const finiteOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
const textOf = (value: unknown): string =>
	value === null || value === undefined ? "" : String(value);

/** Saved summary-sheet rows -> the typed part lines the PDF prints. */
export const storedSummaryLines = (parsed: unknown): CppSummaryRow[] =>
	readStoredPartSummary(parsed).map((row) => ({
		kind: "part" as const,
		slNo: finiteOrNull(row.slNo),
		plant: textOf(row.plant),
		model: textOf(row.model),
		partNo: textOf(row.partNo),
		description: textOf(row.description),
		uom: textOf(row.uom),
		existingPrice: finiteOrNull(row.existingPrice),
		newPrice: finiteOrNull(row.newPrice),
		difference: finiteOrNull(row.difference),
		currentPo: textOf(row.currentPo),
		effectiveDate: textOf(row.effectiveDate),
		rcvdQty: finiteOrNull(row.rcvdQty),
		actualImpact: finiteOrNull(row.actualImpact),
		abpVol: finiteOrNull(row.abpVol),
		qtyPerMc: finiteOrNull(row.qtyPerMc),
		annualisedImpact: finiteOrNull(row.annualisedImpact),
		pctChange: finiteOrNull(row.pctChange),
	}));

/* ── legacy purchasing file ───────────────────────────────────────────────── */
// Requests saved before the summary sheet existed keep their part rows only in the
// purchasing Excel ("purchasingFile"). Two layouts are recognised by sheet name and
// header text, not cell address, so a shifted row or extra column does not break it:
//   1. "Summary" sheet       (THX11-D07-F07)               → summary
//   2. "Price Update" sheet  (Purchase Info Record for TCS) → pir + pirHeader
// It NEVER throws: an unreadable file yields empty arrays and the PDF prints "As per encl".

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

export const EMPTY_PART_ROWS: CppPartRows = { summary: [], pir: [], pirHeader: null };

/** First row (within the first 40) where any cell matches the test. */
const findRow = (grid: Grid, test: (cell: string) => boolean): number => {
	for (let r = 0; r < Math.min(grid.length, 40); r += 1)
		if ((grid[r] ?? []).some((cell) => test(norm(cell)))) return r;
	return -1;
};

const findCol = (row: unknown[], test: (cell: string) => boolean): number =>
	row.findIndex((cell) => test(norm(cell)));

function parseLegacySummary(sheet: XLSX.WorkSheet): CppSummaryLine[] {
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
			// A lone text cell (no numbers) is a group heading, e.g. "Commodity Price Change Q1 FY 26-27".
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

function parseLegacyPir(sheet: XLSX.WorkSheet): { rows: CppPirRow[]; header: CppPirHeader } {
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

	const at = (row: unknown[], i: number) => (i >= 0 ? row[i] : "");
	const rows: CppPirRow[] = [];
	for (let r = headerRow + 2; r < grid.length; r += 1) {
		const row = grid[r] ?? [];
		const partNo = text(row[idx.partNo]);
		if (!partNo) continue;
		rows.push({
			sr: numberOrNull(at(row, idx.sr)),
			partNo,
			description: text(at(row, idx.description)),
			validFrom: dateText(at(row, idx.from)),
			validTo: dateText(at(row, idx.to)),
			condition: text(at(row, idx.condition)),
			price: numberOrNull(at(row, idx.price)),
			needsMasterChange: text(at(row, idx.mm)),
			plant: text(at(row, idx.plant)),
			poForPosa: text(at(row, idx.po)),
		});
	}
	return { rows, header };
}

export function parseCppPartRows(buffer: Buffer): CppPartRows {
	try {
		const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
		const result: CppPartRows = { summary: [], pir: [], pirHeader: null };

		const summaryName = wb.SheetNames.find((n) => /summary/i.test(n));
		if (summaryName) result.summary = parseLegacySummary(wb.Sheets[summaryName]);

		const pirName = wb.SheetNames.find((n) => /price\s*update|info\s*record/i.test(n));
		if (pirName) {
			const { rows, header } = parseLegacyPir(wb.Sheets[pirName]);
			result.pir = rows;
			result.pirHeader = header;
		}
		return result;
	} catch {
		return { summary: [], pir: [], pirHeader: null };
	}
}

/* ── totals ───────────────────────────────────────────────────────────────── */

/** Sums used by the form's Financial Impact box and the Summary Sheet totals. */
export function summariseImpact(lines: CppSummaryLine[]): {
	actual: number | null;
	annual: number | null;
	actualPct: number | null;
	annualPct: number | null;
} {
	const parts = lines.filter((l): l is CppSummaryRow => l.kind === "part");
	if (parts.length === 0) return { actual: null, annual: null, actualPct: null, annualPct: null };

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

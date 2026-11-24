// cpp/cpp.partSummary.ts — the summary sheet (part info) uploaded in Purchasing details.
//
//   buildPartSummaryWorkbook(rows?)  the sheet in the expected format. Header rows and
//                                    columns are locked; data cells stay open. Used by the
//                                    blank template and by the Excel export, so both match.
//   buildPartSummaryTemplate()       the blank sheet as a .xlsx buffer
//   parsePartSummary(buffer)         reads the part rows. Throws ApiError 422 with a message the
//                                    proposer can act on. Pure: no DB, no S3.
//
// Columns are matched by header text, so their order does not matter. Each expected column
// must appear exactly once, and no other column may be added. Sheet protection stops this in
// Excel; the parser is the real check, because a protected sheet can be unprotected (no password).
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

import ApiError from "@shared/utils/apiError";

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

const eq = (text: string) => (h: string) => h === text;
const starts = (text: string) => (h: string) => h.startsWith(text);
const has = (text: string) => (h: string) => h.includes(text);

/** Same columns, in the same order, as the format shown in the Purchasing details modal. */
export const PART_SUMMARY_COLUMNS: PartSummaryColumn[] = [
	{
		key: "slNo",
		group: PRICE_REVISION,
		header: "Sl. No.",
		test: (h) => /^sl\.?\s*no/.test(h),
		number: true,
	},
	{
		key: "plant",
		group: PRICE_REVISION,
		header: "Plant",
		test: eq("plant"),
		number: false,
	},
	{
		key: "model",
		group: PRICE_REVISION,
		header: "Model",
		test: eq("model"),
		number: false,
	},
	{
		key: "partNo",
		group: PRICE_REVISION,
		header: "Part No.",
		test: starts("part no"),
		number: false,
	},
	{
		key: "description",
		group: PRICE_REVISION,
		header: "Description",
		test: eq("description"),
		number: false,
	},
	{
		key: "uom",
		group: PRICE_REVISION,
		header: "UOM",
		test: eq("uom"),
		number: false,
	},
	{
		key: "existingPrice",
		group: PRICE_REVISION,
		header: "Existing Price w.e.f.01.01.26 (INR)",
		test: starts("existing price"),
		number: true,
	},
	{
		key: "newPrice",
		group: PRICE_REVISION,
		header: "New Price (INR)",
		test: starts("new price"),
		number: true,
	},
	{
		key: "difference",
		group: PRICE_REVISION,
		header: "Difference (INR)",
		test: starts("difference"),
		number: true,
	},
	{
		key: "currentPo",
		group: PRICE_REVISION,
		header: "Current PO applicable for PO/SA updation",
		test: has("current po"),
		number: false,
	},
	{
		key: "effectiveDate",
		group: PRICE_REVISION,
		header: "Effective Date",
		test: has("effective date"),
		number: false,
	},
	{
		key: "rcvdQty",
		group: RETRO,
		header: "Rcvd Qty",
		test: starts("rcvd qty"),
		number: true,
	},
	{
		key: "actualImpact",
		group: RETRO,
		header: "Actual Impact",
		test: starts("actual impact"),
		number: true,
	},
	{
		key: "abpVol",
		group: ANNUALISED,
		header: "ABP Vol.",
		test: starts("abp vol"),
		number: true,
	},
	{
		key: "qtyPerMc",
		group: ANNUALISED,
		header: "Qty per m/c",
		test: starts("qty per m"),
		number: true,
	},
	{
		key: "annualisedImpact",
		group: ANNUALISED,
		header: "Annualised Impact",
		test: starts("annualised impact"),
		number: true,
	},
	{
		key: "pctChange",
		group: ANNUALISED,
		header: "% Change",
		test: has("% change"),
		number: true,
	},
];

export type PartSummaryRow = Record<string, string | number | null>;
export type PartSummaryData = { columns: string[]; rows: PartSummaryRow[] };

const norm = (value: unknown): string =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const text = (value: unknown): string =>
	value === null || value === undefined
		? ""
		: String(value).replace(/\s+/g, " ").trim();

/** null = blank, undefined = not a number. */
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

/** Excel date serial -> dd.mm.yyyy; anything else is kept as text. */
const dateText = (value: unknown): string => {
	if (typeof value === "number" && value > 20000 && value < 80000) {
		const d = XLSX.SSF.parse_date_code(value);
		if (d)
			return `${String(d.d).padStart(2, "0")}.${String(d.m).padStart(2, "0")}.${d.y}`;
	}
	return text(value);
};

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
			cell.alignment = {
				wrapText: true,
				vertical: "middle",
				horizontal: "center",
			};
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

/** Reads the part rows from the first sheet. Throws ApiError(422) when the sheet does not fit. */
export const parsePartSummary = (buffer: Buffer): PartSummaryData => {
	const invalid = (message: string) => new ApiError(422, message);

	let grid: unknown[][];
	try {
		const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
		const first = wb.SheetNames[0];
		if (!first) throw new Error("no sheet");
		grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first], {
			header: 1,
			raw: true,
			defval: "",
			blankrows: true,
		});
	} catch {
		throw invalid(
			"The summary sheet could not be read. Upload the Excel (.xlsx) in the expected format.",
		);
	}

	const headerIndex = grid
		.slice(0, 40)
		.findIndex((row) =>
			(row ?? []).some((cell) => norm(cell).startsWith("part no")),
		);
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
		const stray = row.findIndex(
			(cell, i) => text(cell) !== "" && !expectedIndexes.has(i),
		);
		if (stray >= 0)
			throw invalid(
				`Row ${excelRow}: data in column ${stray + 1}, which is not part of the expected format. Do not add columns.`,
			);

		const at = (key: string) => row[columnAt.get(key) ?? -1];
		if (!text(at("partNo")))
			throw invalid(`Row ${excelRow}: Part No. is missing.`);
		if (!text(at("plant"))) throw invalid(`Row ${excelRow}: Plant is missing.`);

		const record: PartSummaryRow = {};
		for (const column of PART_SUMMARY_COLUMNS) {
			const raw = at(column.key);
			if (column.number) {
				const n = toNumber(raw);
				if (n === undefined)
					throw invalid(
						`Row ${excelRow}: "${column.header}" must be a number.`,
					);
				record[column.key] = n;
			} else if (column.key === "effectiveDate") {
				record[column.key] = dateText(raw);
			} else {
				record[column.key] = text(raw);
			}
		}
		rows.push(record);
		if (rows.length > PART_SUMMARY_MAX_ROWS)
			throw invalid(
				`The summary sheet has more than ${PART_SUMMARY_MAX_ROWS} part rows.`,
			);
	}

	if (rows.length === 0)
		throw invalid(
			"No part rows were found. Fill the data rows below the sub-header, then upload again.",
		);
	return { columns: PART_SUMMARY_COLUMNS.map((c) => c.key), rows };
};

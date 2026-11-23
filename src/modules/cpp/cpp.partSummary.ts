// cpp/cpp.partSummary.ts — the summary sheet (part info) uploaded in Purchasing details.
//
//   buildPartSummaryTemplate()  blank sheet in the expected format (group row + header row)
//   parsePartSummary(buffer)    reads the part rows. Throws ApiError 422 with a message the
//                               proposer can act on. Pure: no DB, no S3.
//
// The sheet is "formatted": columns are matched by header text, so their order does not
// matter, but every expected column must be present.
import * as XLSX from "xlsx";

import ApiError from "@shared/utils/apiError";

export const PART_SUMMARY_MAX_ROWS = 2000;

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

const norm = (value: unknown): string =>
	String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const text = (value: unknown): string =>
	value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();

/** null = blank, undefined = not a number. */
const toNumber = (value: unknown): number | null | undefined => {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const cleaned = String(value).replace(/[₹,\s]/g, "").replace(/%$/, "");
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

/** Blank sheet in the expected format: the group row, then the header row. */
export const buildPartSummaryTemplate = (): Buffer => {
	const columns = PART_SUMMARY_COLUMNS;
	const groupRow = columns.map((c, i) =>
		i === 0 || columns[i - 1].group !== c.group ? c.group : "",
	);
	const merges: XLSX.Range[] = [];
	let start = 0;
	for (let i = 1; i <= columns.length; i += 1) {
		if (i === columns.length || columns[i].group !== columns[start].group) {
			if (i - 1 > start)
				merges.push({ s: { r: 0, c: start }, e: { r: 0, c: i - 1 } });
			start = i;
		}
	}
	const ws = XLSX.utils.aoa_to_sheet([
		groupRow,
		columns.map((c) => c.header),
	]);
	ws["!merges"] = merges;
	ws["!cols"] = columns.map(() => ({ wch: 16 }));
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Summary");
	return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
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
		.findIndex((row) => (row ?? []).some((cell) => norm(cell).startsWith("part no")));
	if (headerIndex < 0)
		throw invalid(
			'The summary sheet has no "Part No." header row. Keep the header and sub-header rows from the template.',
		);

	const header = (grid[headerIndex] ?? []).map(norm);
	const columnAt = new Map<string, number>();
	const missing: string[] = [];
	for (const column of PART_SUMMARY_COLUMNS) {
		const index = header.findIndex(column.test);
		if (index < 0) missing.push(column.header);
		else columnAt.set(column.key, index);
	}
	if (missing.length)
		throw invalid(
			`The summary sheet is missing column(s): ${missing.join(", ")}. Use the expected format and do not rename or remove columns.`,
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
		const at = (key: string) => row[columnAt.get(key) ?? -1];
		if (!text(at("partNo")))
			throw invalid(`Row ${excelRow}: Part No. is missing.`);
		if (!text(at("plant")))
			throw invalid(`Row ${excelRow}: Plant is missing.`);

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

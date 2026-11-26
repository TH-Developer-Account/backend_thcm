import type {
	Content,
	ContentCanvas,
	StyleDictionary,
	Style,
	TableCell,
	TDocumentDefinitions,
} from "pdfmake/interfaces";

import { LOGO_DATA_URI } from "@vendor-onboarding/vendorOnboardingLogo";

import {
	statusLabel,
	type CppPdfData,
	type CppSigner,
	type CppWorkflowRow,
	type FinancialRow,
	type ImpactRow,
	type TextRow,
} from "./cppAssembler";
import type { CppPirRow, CppSummaryLine, CppSummaryRow } from "./cpp.sheet";

// ─────────────────────────────────────────────────────────────────────────────
// CPP — DOC DEFINITION (A4 landscape)
//
// Page 1  Format no. THX11-D07-F02 Ver 1.5  "Direct / Indirect Material /
//         Spare Parts – Price Approval"   (the form)
// Page 2+ Format no. THX11-D07-F07 Ver 1.5  "Summary Sheet for Price Changes"
//         (only when the uploaded Excel has part rows)
// Last    Approval workflow + audit trail, as tables.
// Supplier annexures (uploaded PDFs / images) are appended by the PDF service.
//
// Everything printed comes from CppPdfData, which reads the same saved
// sections as the on-screen sheet (CppPdfView.tsx). Cells the data cannot fill
// stay blank, exactly like an unsigned paper form — nothing is invented.
// ─────────────────────────────────────────────────────────────────────────────

/* --------------------------- layout constants (pt) -------------------------- */

const PAGE_MARGIN_X = 20;
const PAGE_MARGIN_TOP = 16;
const PAGE_MARGIN_BOTTOM = 16;
/** A4 landscape = 841.89 pt wide. */
const W = 798;

const BLACK = "#000000";
const GREY_BAR = "#D9D9D9";
const GREY_HEAD = "#F2F2F2";
const BLUE = "#8DB4E2";
const SOFT_TEXT = "#7F7F7F";
const LINE = 0.5;

const FS = 6; // base font size of the form

const FORM_LAYOUT = {
	hLineWidth: () => LINE,
	vLineWidth: () => LINE,
	hLineColor: () => BLACK,
	vLineColor: () => BLACK,
	paddingLeft: () => 2,
	paddingRight: () => 2,
	paddingTop: () => 1.3,
	paddingBottom: () => 1.3,
};

const NO_PAD_LAYOUT = {
	hLineWidth: () => 0,
	vLineWidth: () => 0,
	paddingLeft: () => 0,
	paddingRight: () => 0,
	paddingTop: () => 0,
	paddingBottom: () => 0,
};

const OUTER_LAYOUT = {
	hLineWidth: () => 1.4,
	vLineWidth: () => 1.4,
	hLineColor: () => BLACK,
	vLineColor: () => BLACK,
	paddingLeft: () => 0,
	paddingRight: () => 0,
	paddingTop: () => 0,
	paddingBottom: () => 0,
};

const STYLES: StyleDictionary = {};

const DEFAULT_STYLE: Style = {
	font: "Helvetica",
	fontSize: FS,
	lineHeight: 1.1,
	color: BLACK,
};

/* --------------------------------- helpers --------------------------------- */

/** pdfmake's Content types have no `width`, but a column child may carry one. */
type Col = Content & { width?: number | string };

/** pdfmake adds the cell padding on top of a fixed column width; take it off so
 *  the columns add up to exactly the width they were given. */
const PAD_X = 4;
const tw = (widths: number[]): number[] =>
	widths.map((w) => Math.max(w - PAD_X, 1));

const NONE: [boolean, boolean, boolean, boolean] = [false, false, false, false];

const pad2 = (n: number) => String(n).padStart(2, "0");

const dmy = (d: Date | null | undefined, sep = "-"): string =>
	d
		? `${pad2(d.getDate())}${sep}${pad2(d.getMonth() + 1)}${sep}${d.getFullYear()}`
		: "";

/** "2026-11-26" -> "26-11-2026"; anything else is printed as saved. */
const isoToDmy = (value: string): string => {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
};

/** Date + time in India time, whatever the server's time zone. */
const IST = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Asia/Kolkata",
	day: "2-digit",
	month: "2-digit",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});
const istDateTime = (d: Date | null | undefined): string =>
	d ? IST.format(d).replace(",", "") : "";

const fmtNum = (n: number | null | undefined): string => {
	if (n === null || n === undefined || !Number.isFinite(n)) return "";
	return n.toLocaleString("en-IN", {
		minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
		maximumFractionDigits: 2,
	});
};

/** A saved number string with Indian grouping; anything else as typed. */
const fmtText = (value: string | undefined): string => {
	const s = (value ?? "").trim();
	if (!s) return "";
	const n = Number(s);
	return Number.isFinite(n) ? fmtNum(n) : s;
};

/** Fraction -> "5.00%". */
const fmtPct = (fraction: number | null | undefined, dp = 2): string =>
	fraction === null || fraction === undefined || !Number.isFinite(fraction)
		? ""
		: `${(fraction * 100).toFixed(dp)}%`;

/** Percent units (5 = 5 %) -> "5.00%". */
const fmtPercent = (value: number | null | undefined, dp = 2): string =>
	value === null || value === undefined || !Number.isFinite(value)
		? ""
		: `${value.toFixed(dp)}%`;

/** Keeps a cell on one line: long text is cut with an ellipsis. */
const clip = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

type Opts = Partial<{
	fs: number;
	bold: boolean;
	italics: boolean;
	align: "left" | "center" | "right";
	fill: string;
	color: string;
	span: number;
	rowSpan: number;
	border: [boolean, boolean, boolean, boolean];
	margin: [number, number, number, number];
	valign: boolean;
}>;

/** One table cell. `span` > 1 must be followed by `blanks(span - 1)`. */
function c(text: string, o: Opts = {}): TableCell {
	return {
		text: text === "" ? " " : text,
		fontSize: o.fs ?? FS,
		bold: o.bold,
		italics: o.italics,
		alignment: o.align,
		fillColor: o.fill,
		color: o.color,
		colSpan: o.span,
		rowSpan: o.rowSpan,
		border: o.border,
		margin: o.margin,
	} as TableCell;
}

const blanks = (n: number): TableCell[] =>
	Array.from({ length: n }, (): TableCell => ({ text: "" }));

/** A cell spanning `n` columns, plus the placeholder cells pdfmake needs. */
const spanned = (n: number, cell: TableCell): TableCell[] => [
	{ ...(cell as object), colSpan: n } as TableCell,
	...blanks(n - 1),
];

const emptyRow = (cols: number, o: Opts = {}): TableCell[] =>
	Array.from({ length: cols }, () => c("", o));

const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

/**
 * Rows for a small fixed-height box on page 1: the saved rows, padded with
 * empty rows to `min`, at most `max` (the last row then says how many more).
 */
function boxRows(
	rows: TextRow[],
	cols: number,
	min: number,
	max: number,
	toCells: (row: TextRow) => TableCell[],
	fs = 5.4,
): TableCell[][] {
	const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
	const out = shown.map(toCells);
	if (rows.length > max)
		out.push([
			...spanned(
				cols,
				c(`+ ${rows.length - shown.length} more (see the CPP request)`, {
					italics: true,
					color: SOFT_TEXT,
					fs,
				}),
			),
		]);
	while (out.length < min) out.push(emptyRow(cols));
	return out;
}

/** A tick drawn as a vector, so it does not depend on the font's glyphs. */
const tick = (size = 6): ContentCanvas & { width?: number } => ({
	canvas: [
		{
			type: "polyline",
			closePath: false,
			lineWidth: 1.1,
			lineColor: BLACK,
			points: [
				{ x: 0, y: size * 0.55 },
				{ x: size * 0.38, y: size * 0.95 },
				{ x: size, y: 0 },
			],
		},
	],
	width: size + 1,
});

/** "A →" drawn with a vector arrow, because Helvetica has no arrow glyph. */
function labelWithArrow(label: string, o: Opts = {}): TableCell {
	return {
		columns: [
			{
				text: label,
				width: "*",
				bold: o.bold,
				fontSize: o.fs ?? FS,
				alignment: o.align ?? "center",
			},
			{
				width: 9,
				canvas: [
					{
						type: "line",
						x1: 0,
						y1: 4,
						x2: 7.5,
						y2: 4,
						lineWidth: 0.7,
						lineColor: BLACK,
					},
					{
						type: "polyline",
						closePath: false,
						lineWidth: 0.7,
						lineColor: BLACK,
						points: [
							{ x: 5, y: 1.8 },
							{ x: 7.8, y: 4 },
							{ x: 5, y: 6.2 },
						],
					},
				],
				margin: [0, 1.2, 0, 0],
			},
		],
		columnGap: 1,
		border: o.border,
		colSpan: o.span,
		fillColor: o.fill,
	} as TableCell;
}

/** Label followed by an optional tick, as one cell. */
function labelWithTick(
	label: string,
	ticked: boolean,
	o: Opts = {},
): TableCell {
	return {
		columns: [
			{ text: label, width: "auto", fontSize: o.fs ?? FS, bold: o.bold },
			...(ticked
				? [
						{
							...tick(5.5),
							margin: [1, 0.5, 0, 0] as [number, number, number, number],
						},
					]
				: []),
		],
		columnGap: 0,
		fillColor: o.fill,
		border: o.border,
		colSpan: o.span,
	} as TableCell;
}

const grey = (title: string, width: number, fs = 6.5): Content => ({
	table: {
		widths: tw([width]),
		body: [[c(title, { fs, fill: GREY_BAR, border: NONE })]],
	},
	layout: NO_PAD_LAYOUT_WITH_TEXT_PAD(),
});

function NO_PAD_LAYOUT_WITH_TEXT_PAD() {
	return {
		...NO_PAD_LAYOUT,
		paddingLeft: () => 2,
		paddingRight: () => 2,
		paddingTop: () => 1.6,
		paddingBottom: () => 1.6,
	};
}

const italicNote = (t: string, topMargin = 0): Content => ({
	text: t,
	italics: true,
	fontSize: 5.5,
	color: SOFT_TEXT,
	margin: [0, topMargin, 0, 0],
});

/** Vertical caption (e.g. "CPP Committee Approval") drawn as rotated SVG text. */
function verticalLabel(label: string, height: number): Col {
	const size = 4.6;
	const safe = label
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return {
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="${height}" viewBox="0 0 8 ${height}"><text transform="translate(6 ${height / 2}) rotate(-90)" text-anchor="middle" font-size="${size}" font-family="Helvetica" fill="${SOFT_TEXT}">${safe}</text></svg>`,
		width: 8,
		height,
	} as Content;
}

/* ------------------------------ signature blocks ---------------------------- */

const statusLine = (s: CppSigner): string =>
	s.status === "APPROVED" && s.actedAt ? `Approved ${dmy(s.actedAt, "/")}` : "";

/** Names side by side, bottom-aligned like the paper form. */
function signerRow(
	signers: CppSigner[],
	width: number,
	minHeight: number,
	perRow = 4,
): Col {
	if (signers.length === 0) return { text: " ", margin: [0, minHeight, 0, 0] };
	const rows: CppSigner[][] = [];
	for (let i = 0; i < signers.length; i += perRow)
		rows.push(signers.slice(i, i + perRow));
	return {
		stack: rows.map((row, i) => ({
			columns: row.map((s) => ({
				width: width / perRow,
				stack: [
					{
						text: s.name,
						bold: true,
						fontSize: 5.4,
						alignment: "center" as const,
					},
					s.designation
						? {
								text: s.designation,
								fontSize: 4.8,
								alignment: "center" as const,
							}
						: { text: " ", fontSize: 4.8 },
					statusLine(s)
						? {
								text: statusLine(s),
								fontSize: 4.2,
								color: SOFT_TEXT,
								alignment: "center" as const,
							}
						: { text: " ", fontSize: 4.2 },
				],
			})),
			columnGap: 0,
			margin: [0, i === 0 ? minHeight : 4, 0, 0] as [
				number,
				number,
				number,
				number,
			],
		})),
	};
}

/* ================================ PAGE 1 — F02 =============================== */

function headerBand(title: string, sub1: string, sub2: string): Col {
	return {
		columns: [
			LOGO_DATA_URI
				? {
						image: "logo",
						fit: [86, 40],
						width: 96,
						margin: [4, 3, 0, 0] as [number, number, number, number],
					}
				: {
						text: "TATA HITACHI",
						bold: true,
						fontSize: 11,
						width: 96,
						margin: [4, 8, 0, 0] as [number, number, number, number],
					},
			{
				width: "*",
				stack: [
					{
						text: title,
						bold: true,
						italics: true,
						fontSize: 7.2,
						alignment: "right",
					},
					{
						text: sub1,
						bold: true,
						italics: true,
						fontSize: 7.2,
						alignment: "right",
					},
					{
						text: sub2,
						bold: true,
						italics: true,
						fontSize: 7.2,
						alignment: "right",
					},
				],
				margin: [0, 6, 6, 0] as [number, number, number, number],
			},
		],
		columnGap: 0,
	};
}

const hRule = (width: number, y = 0): ContentCanvas => ({
	canvas: [
		{
			type: "line",
			x1: 0,
			y1: y,
			x2: width,
			y2: y,
			lineWidth: 0.9,
			lineColor: BLACK,
		},
	],
});

/** Reason row + Approval Ref. */
function reasonRow(d: CppPdfData): Col {
	const eff = (name: string) =>
		d.effects.some((e) => e.toLowerCase() === name.toLowerCase());
	const q = eff("quality");
	const co = eff("cost");
	const de = eff("delivery");
	const mark = (ticked: boolean) => (ticked ? "X" : " ");

	return {
		margin: [2, 4, 2, 4] as [number, number, number, number],
		columns: [
			{
				width: 158,
				table: {
					widths: tw([158]),
					heights: [24],
					body: [
						[
							{
								stack: [
									{
										text: "Reason for Price Update :",
										bold: true,
										fontSize: 6.6,
										alignment: "center",
									},
									{
										text: "(Please Select from Drop Down )",
										bold: true,
										fontSize: 6.6,
										alignment: "center",
									},
								],
								fillColor: GREY_HEAD,
								margin: [0, 4, 0, 0],
							} as TableCell,
						],
					],
				},
				layout: FORM_LAYOUT,
			},
			{
				width: 150,
				table: {
					widths: tw([150]),
					heights: [24],
					body: [
						[
							{
								text: d.reason || " ",
								bold: true,
								fontSize: 7,
								alignment: "center",
								margin: [0, 8, 0, 0],
							} as TableCell,
						],
					],
				},
				layout: FORM_LAYOUT,
				margin: [4, 0, 0, 0] as [number, number, number, number],
			},
			{
				width: 178,
				table: {
					widths: tw([178]),
					heights: [24],
					body: [
						[
							{
								stack: [
									{
										text: `Effect: Quality ( ${mark(q)} )/ Cost ( ${mark(co)} )/ Delivery( ${mark(de)} )`,
										bold: true,
										fontSize: 7,
									},
									{
										text: "(Please Tick)- Only for Existing Materials",
										bold: true,
										fontSize: 5,
									},
								],
								margin: [0, 3, 0, 0],
							} as TableCell,
						],
					],
				},
				layout: FORM_LAYOUT,
				margin: [4, 0, 0, 0] as [number, number, number, number],
			},
			{ width: "*", text: "" },
			{
				width: 150,
				stack: [
					{
						columns: [
							{
								text: "Approval Ref. :",
								bold: true,
								fontSize: 7,
								width: 60,
								alignment: "right",
							},
							{
								text: d.referenceNumber,
								bold: true,
								fontSize: 6,
								width: "*",
								margin: [4, 0.6, 0, 0] as [number, number, number, number],
							},
						],
					},
					{
						columns: [
							{
								text: "Date :",
								bold: true,
								fontSize: 7,
								width: 60,
								alignment: "right",
							},
							{
								text: dmy(d.date),
								bold: true,
								fontSize: 6,
								width: "*",
								margin: [4, 0.6, 0, 0] as [number, number, number, number],
							},
						],
						margin: [0, 2, 0, 0] as [number, number, number, number],
					},
				],
				margin: [0, 3, 0, 0] as [number, number, number, number],
			},
		],
	};
}

/* ---- purchasing details (left) ---- */

const PART_COLS = [58, 78, 27, 57, 33, 57, 28, 57, 57, 39, 36, 30]; // = 557
const LEFT_W = sum(PART_COLS);

function purchasingTable(d: CppPdfData): Col {
	const s = d.suppliers;
	const label = (t: string, o: Opts = {}) => c(t, { bold: true, ...o });
	const supplierRows: TableCell[][] = [
		[
			c("", { span: 3, border: NONE }),
			...blanks(2),
			...spanned(4, label("Existing Supplier")),
			...spanned(2, label("Other Supplier")),
			...spanned(3, label("Recommended Supplier")),
		],
		[
			c("", { span: 3, border: NONE }),
			...blanks(2),
			...spanned(4, c(`Name :   ${s.existing.name}`)),
			...spanned(2, c(`Name :   ${s.other.name}`)),
			...spanned(3, c(`Name :   ${s.recommended.name}`)),
		],
		[
			c("", { span: 3, border: NONE }),
			...blanks(2),
			...spanned(4, c(`Code :   ${s.existing.code}`)),
			...spanned(2, c(`Code :   ${s.other.code}`)),
			...spanned(3, c(`Code :   ${s.recommended.code}`)),
		],
	];
	// The "more than 5 parts" note sits in the empty top-left area, like the paper form.
	const note =
		d.partCount > d.formParts.length
			? `Showing ${d.formParts.length} of ${d.partCount} parts, please see the summary sheet`
			: "For more than 5 parts, please use summary sheet";
	(supplierRows[1][0] as TableCell & { text: string }) = {
		text: note,
		italics: true,
		fontSize: 5.4,
		color: SOFT_TEXT,
		alignment: "center",
		colSpan: 3,
		border: NONE,
		margin: [0, 2, 0, 0],
	} as TableCell & { text: string };

	const head1: TableCell[] = [
		c("Part No.", {
			bold: true,
			align: "center",
			rowSpan: 2,
			margin: [0, 5, 0, 0],
		}),
		c("Description", {
			bold: true,
			align: "center",
			rowSpan: 2,
			margin: [0, 5, 0, 0],
		}),
		c("UOM", { bold: true, align: "center", rowSpan: 2, margin: [0, 5, 0, 0] }),
		...spanned(2, c("Existing Price", { bold: true, align: "center" })),
		...spanned(2, c("Quoted Price", { bold: true, align: "center" })),
		...spanned(2, c("Quoted Price", { bold: true, align: "center" })),
		...spanned(3, c("Price Finalised", { bold: true, align: "center" })),
	];
	const head2: TableCell[] = [
		{ text: "" },
		{ text: "" },
		{ text: "" },
		c("Unit Rate in INR", { bold: true, align: "center", fs: 5.2 }),
		c("w.e.f", { bold: true, align: "center", fs: 5.2 }),
		c("Unit Rate in INR", { bold: true, align: "center", fs: 5.2 }),
		c("w.e.f", { bold: true, align: "center", fs: 5.2 }),
		c("Unit Rate in INR", { bold: true, align: "center", fs: 5.2 }),
		c("w.e.f.", { bold: true, align: "center", fs: 5.2 }),
		c("Unit Rate in INR", { bold: true, align: "center", fs: 5.2 }),
		c("w.e.f", { bold: true, align: "center", fs: 5.2 }),
		c("% Impact", { bold: true, align: "center", fs: 5.2 }),
	];

	// The first five summary-sheet parts, as on the view. One line each: the
	// full description is on the summary sheet.
	const partRows: TableCell[][] = d.formParts.map((p) => [
		c(clip(p.partNo, 16), { fs: 5.4 }),
		c(clip(p.description, 24), { fs: 5 }),
		c(p.uom, { align: "center", fs: 5.4 }),
		c(fmtNum(p.existingPrice), { align: "right", fs: 5.4 }),
		c(""),
		c(""),
		c(""),
		c(""),
		c(""),
		c(fmtNum(p.newPrice), { align: "right", fs: 5.4 }),
		c(clip(p.effectiveDate, 11), { align: "center", fs: 5 }),
		c(fmtPct(p.pctChange, 1), { align: "right", fs: 5.2 }),
	]);
	while (partRows.length < 5) partRows.push(emptyRow(PART_COLS.length));

	return {
		table: {
			widths: tw(PART_COLS),
			body: [...supplierRows, head1, head2, ...partRows],
		},
		layout: FORM_LAYOUT,
	};
}

function lowerLeftTables(d: CppPdfData): Col {
	const AMORT = [40, 30, 38, 26, 34]; // 168
	const PM = [34, 34, 36, 36]; // 140
	const VOL = [100, 46, 46, 46]; // 238
	const gap = LEFT_W - sum(AMORT) - sum(PM) - sum(VOL);
	const g = gap / 2;
	const cell = (t: string, align: Opts["align"] = "right") =>
		c(t, { fs: 5.4, align });

	const amort: Col = {
		width: sum(AMORT),
		stack: [
			italicNote("In case of Amortisation Only :"),
			{
				table: {
					widths: tw(AMORT),
					body: [
						[
							"Part No",
							"Price incl. Amort.",
							"Cutoff Date",
							"Amort. Qty.",
							"Price After Amort.",
						].map((t) => c(t, { bold: true, align: "center", fs: 5.2 })),
						...boxRows(d.amortisation, 5, 3, 5, (r) => [
							cell(clip(r.partNo, 14), "left"),
							cell(fmtText(r.priceInclAmort)),
							cell(isoToDmy(r.cutoffDate), "center"),
							cell(fmtText(r.amortQty)),
							cell(fmtText(r.priceAfterAmort)),
						]),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
	const perMachine: Col = {
		width: sum(PM),
		stack: [
			italicNote("Per Machine Impact :"),
			{
				table: {
					widths: tw(PM),
					body: [
						[
							"Plant",
							"Model",
							"Impact in Rs. (With Amort.)",
							"Impact in Rs. (W/O Amort.)",
						].map((t) => c(t, { bold: true, align: "center", fs: 5.2 })),
						...boxRows(d.perMachine, 4, 3, 5, (r) => [
							cell(r.plant, "center"),
							cell(clip(r.model, 12), "left"),
							cell(fmtText(r.withAmort)),
							cell(fmtText(r.withoutAmort)),
						]),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
	const v = d.volumes;
	const volCells = (pick: (p: ImpactRow) => string) =>
		(["DWD", "KGP", "SPARE"] as ImpactRow[]).map((p) =>
			c(fmtText(pick(p)), { fs: 5.4, align: "right" }),
		);
	const volumes: Col = {
		width: sum(VOL),
		stack: [
			italicNote("Volumes Taken For Calculation :"),
			{
				table: {
					widths: tw(VOL),
					body: [
						[
							labelWithArrow("Plant", { bold: true }),
							c("DWD", { bold: true, align: "center" }),
							c("KGP", { bold: true, align: "center" }),
							c("SPARE", { bold: true, align: "center" }),
						],
						[...spanned(4, c("For Actual", { bold: true, fill: GREY_HEAD }))],
						[
							c("Rcvd Qty. (Till Date) = a", { fs: 5.4 }),
							...volCells((p) => v[p].received),
						],
						[
							c("Remaining Qty. = b", { fs: 5.4 }),
							...volCells((p) => v[p].remaining),
						],
						[
							...spanned(
								4,
								c("For Annualised", { bold: true, fill: GREY_HEAD }),
							),
						],
						[
							c("Qty./mc x ABP No's = c", { fs: 5.4 }),
							...volCells((p) => v[p].annual),
						],
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
	return {
		columns: [
			amort,
			{ width: g, text: "" },
			perMachine,
			{ width: g, text: "" },
			volumes,
		],
		columnGap: 0,
		margin: [0, 3, 0, 0] as [number, number, number, number],
	};
}

/* ---- financial impact (right) ---- */

const RIGHT_W = W - LEFT_W - 6 - 4; // outer padding (2 + 2)
function financialBlock(d: CppPdfData): Col {
	const wd = [30, 62, 34, 72, RIGHT_W - 30 - 62 - 34 - 72];
	const b = { bold: true, align: "center" as const };
	const rowLabel = (t: string) =>
		c(t, { fs: 6.4, align: "center", margin: [0, 3.5, 0, 3.5] });
	const plantRow = (key: ImpactRow): TableCell[] => {
		const p: FinancialRow = d.financial[key];
		const n = {
			fs: 6.4,
			align: "right" as const,
			margin: [0, 3.5, 0, 3.5] as [number, number, number, number],
		};
		return [
			rowLabel(key),
			c(fmtNum(p.actual), n),
			c(fmtPercent(p.actualPct), n),
			c(fmtNum(p.annual), n),
			c(fmtPercent(p.annualPct), n),
		];
	};
	const t = d.financialTotal;
	const totalCell = (text: string, fs = 6.4) =>
		c(text, { bold: true, fs, align: "right", margin: [0, 2, 0, 2] });
	const total: TableCell[] = [
		c("Total", { bold: true, fs: 6.4, align: "center", margin: [0, 2, 0, 2] }),
		totalCell(fmtNum(t.actual), 6.6),
		totalCell(fmtPercent(t.actualPct)),
		totalCell(t.annual === null ? "" : `Rs. ${fmtNum(t.annual)}`, 6.6),
		totalCell(fmtPercent(t.annualPct)),
	];
	return {
		stack: [
			grey("Financial Impact :", RIGHT_W),
			italicNote("(+ve. -> Price Increase, -ve. -> Price Decrease)"),
			{
				margin: [0, 1, 0, 0] as [number, number, number, number],
				table: {
					widths: tw(wd),
					body: [
						[
							c("", { border: NONE, span: 1 }),
							...spanned(2, c("Actual = [(a+ b)X Impact]", { ...b, fs: 5.6 })),
							...spanned(
								2,
								c("Annual Impact = [ c X Impact]", { ...b, fs: 5.6 }),
							),
						],
						[
							c("", { border: NONE }),
							c("in INR", { ...b, fs: 5.4 }),
							c("in %", { ...b, fs: 5.4 }),
							c("in INR", { ...b, fs: 5.4 }),
							c("in %", { ...b, fs: 5.4 }),
						],
						plantRow("KGP"),
						plantRow("DWD"),
						plantRow("SPARE"),
						total,
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

function otherDataBlock(d: CppPdfData): Col {
	const wd = [55, 90, RIGHT_W - 55 - 90];
	return {
		margin: [0, 6, 0, 0] as [number, number, number, number],
		stack: [
			grey("Other Data", RIGHT_W),
			{
				table: {
					widths: tw(wd),
					body: [
						[
							...spanned(
								3,
								c("Price in Other Plant Location (if any)", {
									bold: true,
									italics: true,
									align: "center",
									fs: 6.2,
								}),
							),
						],
						[
							c("Plant", { fs: 6.2 }),
							c("Part Number", { fs: 6.2 }),
							c("Price", { fs: 6.2 }),
						],
						...boxRows(
							d.plantPrices,
							3,
							3,
							4,
							(r) => [
								c(r.plant, { fs: 6 }),
								c(clip(r.partNumber, 20), { fs: 6 }),
								c(fmtText(r.price), { fs: 6, align: "right" }),
							],
							6,
						),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

/* ---- lower-left column ---- */

const COL_L = 137;

function leftColumnTop(d: CppPdfData): Col {
	const plantRows: Array<[string, string]> = [
		["DWD", "1006"],
		["KGP", "3006"],
		["KGP WH", "8445"],
		["DWD WH", "8580"],
		["NGP", "8400"],
	];
	// Applicable = the plant / warehouse rows saved on the Master data tab (as on
	// the view). Requests saved before that use the plant names of step 1.
	const codes = new Set(d.applicableCodes);
	const names = new Set(
		d.applicablePlants.map((p) => p.toUpperCase().replace(/\s+/g, " ")),
	);
	const isApplicable = (name: string, code: string) =>
		codes.size > 0 ? codes.has(code) : names.has(name);
	const plantsTable: Col = {
		table: {
			widths: tw([30, 28, 33]),
			body: plantRows.map(([name, code]) => {
				const strong = name === "DWD" || name === "KGP";
				return [
					c(name, {
						bold: true,
						align: "center",
						fill: strong ? BLUE : undefined,
						fs: strong ? 6.4 : 5.2,
					}),
					c(code, {
						bold: true,
						align: "center",
						fill: strong ? BLUE : undefined,
						fs: strong ? 6.4 : 5.2,
					}),
					c(isApplicable(name, code) ? "Yes" : "No", {
						bold: true,
						align: "center",
						fs: 6.2,
					}),
				];
			}),
		},
		layout: FORM_LAYOUT,
	};

	const std = d.priceType === "STANDARD" || d.priceType === "";
	const sub = d.priceType === "SUBCONTRACTING";
	const on = (code: string) => d.pricingCondition.toUpperCase() === code;
	const conditionTable: Col = {
		table: {
			widths: tw([60, 74]),
			body: [
				[
					labelWithTick("PB00  Regular", on("PB00"), { bold: true }),
					labelWithTick("PB50  Amortised", on("PB50"), { bold: true }),
				],
				[
					labelWithTick("PB25  One Time", on("PB25"), { bold: true }),
					labelWithTick("PB75  Provisional", on("PB75"), { bold: true }),
				],
			],
		},
		layout: FORM_LAYOUT,
	};

	return {
		width: COL_L,
		stack: [
			{
				table: {
					widths: tw([30, COL_L - 30]),
					heights: [20],
					body: [
						[
							c("Models :", { bold: true, fs: 6.4, margin: [0, 6, 0, 0] }),
							c(d.models.join("/"), { fs: 5.6, margin: [0, 1, 0, 0] }),
						],
					],
				},
				layout: FORM_LAYOUT,
			},
			{
				margin: [0, 4, 0, 0] as [number, number, number, number],
				columns: [
					{
						width: 46,
						text: "Applicable Plant(s) :\n(Y/N)",
						bold: true,
						fontSize: 5.8,
						alignment: "center",
						margin: [0, 14, 0, 0] as [number, number, number, number],
					},
					{ width: 91, stack: [plantsTable] },
				],
				columnGap: 0,
			},
			{
				margin: [0, 4, 0, 0] as [number, number, number, number],
				columns: [
					{
						width: 44,
						text: "Price Type :",
						bold: true,
						fontSize: 6.4,
						margin: [0, 4, 0, 0] as [number, number, number, number],
					},
					{
						width: COL_L - 44,
						table: {
							widths: tw([COL_L - 44]),
							body: [
								[
									labelWithTick("Standard", std, {
										fill: std ? BLUE : undefined,
									}),
								],
								[
									labelWithTick("Subcontracting (MASOP)", sub, {
										fill: sub ? BLUE : undefined,
									}),
								],
							],
						},
						layout: FORM_LAYOUT,
					},
				],
				columnGap: 0,
			},
			{
				margin: [0, 5, 0, 0] as [number, number, number, number],
				stack: [
					{
						text: "Pricing Condition :",
						bold: true,
						fontSize: 6.4,
						fillColor: GREY_BAR,
					},
					conditionTable,
				],
			},
		],
	};
}

function leftColumnBottom(d: CppPdfData): Col {
	const m = d.master;
	const sp = d.spares;
	const lw = [46, COL_L - 46];
	const forPlants: Col = {
		table: {
			widths: tw(lw),
			body: [
				[c("Inco Terms :", { bold: true }), c(m.incoTerms)],
				[c("Purch. Grp. :", { bold: true }), c(m.purchasingGroup)],
				[c("Tax Code :", { bold: true }), c(m.taxCode)],
				[c("Store Loc. :", { bold: true }), c(m.storeLocation)],
			],
		},
		layout: FORM_LAYOUT,
	};
	const pf =
		sp.pfPct && /^-?\d+(\.\d+)?$/.test(sp.pfPct) ? `${sp.pfPct}%` : sp.pfPct;
	const forSpares: Col = {
		table: {
			widths: tw(lw),
			body: [
				[
					c("Inco Terms", { bold: true, fill: BLUE }),
					c(sp.incoTerms, { fill: BLUE }),
				],
				[c("P&F (%age) :", { bold: true, fill: BLUE }), c(pf, { fill: BLUE })],
				[
					c("Tax Code :", { bold: true, fill: BLUE }),
					c(sp.taxCode, { fill: BLUE }),
				],
			],
		},
		layout: FORM_LAYOUT,
	};
	return {
		width: COL_L,
		stack: [
			italicNote("For Plants"),
			forPlants,
			italicNote("For Spares", 5),
			forSpares,
		],
	};
}

/* ---- justification: the widest box in the middle band ---- */

const MID_W = 300;
const BOX_H = 186;

/** Bigger text for short justifications; the 2000-character maximum still fits. */
function fitJustification(text: string): { text: string; fs: number } {
	const t = text.replace(/\r\n/g, "\n").trim();
	if (t.length <= 1000) return { text: t, fs: 8.4 };
	if (t.length <= 1500) return { text: t, fs: 7.2 };
	if (t.length <= 2200) return { text: t, fs: 6.2 };
	if (t.length <= 2700) return { text: t, fs: 5.6 };
	return { text: `${t.slice(0, 2650).trimEnd()} …`, fs: 5.6 };
}

function justificationBlock(d: CppPdfData): Col {
	const j = fitJustification(d.justification);
	return {
		width: MID_W,
		stack: [
			{
				table: {
					widths: tw([MID_W]),
					body: [
						[
							c("Justification :", {
								bold: true,
								fs: 7,
								fill: GREY_BAR,
								border: NONE,
							}),
						],
					],
				},
				layout: NO_PAD_LAYOUT_WITH_TEXT_PAD(),
			},
			{
				table: {
					widths: tw([MID_W]),
					heights: [BOX_H],
					body: [
						[
							{
								text: j.text || " ",
								italics: true,
								fontSize: j.fs,
								lineHeight: 1.18,
								margin: [3, 3, 3, 0],
							} as TableCell,
						],
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

/* ---- right column: tracker + initiated-by ---- */

const COL_R = W - 4 - COL_L - MID_W - 8; // 4 = the 2 + 2 inner margin

function trackerBlock(d: CppPdfData): Col {
	const fixed = [50, 46, 64, 56, 56];
	const wd = [...fixed, COL_R - sum(fixed)];
	const heads = [
		"Model",
		"Per Machine Impact",
		"Budgeted increase in Price (Per M/c – FY16)",
		"Status YTD ( FY19)",
		"Budgeted Material Cost",
		"Material Cost YTD",
	];
	const n = (t: string) => c(fmtText(t), { fs: 5.4, align: "right" });
	return {
		stack: [
			{
				text: "Material Cost Tracker (All Value in Lakhs INR)",
				fontSize: 6.6,
				alignment: "center",
				margin: [0, 1, 0, 2] as [number, number, number, number],
			},
			{
				table: {
					widths: tw(wd),
					body: [
						heads.map((h) =>
							c(h, {
								bold: true,
								align: "center",
								fs: 5.2,
								margin: [0, 1, 0, 1],
							}),
						),
						...boxRows(d.costTracker, 6, 5, 6, (r) => [
							c(clip(r.model, 14), { fs: 5.4 }),
							n(r.perMachineImpact),
							n(r.budgetedIncrease),
							n(r.statusYtd),
							n(r.budgetedMaterialCost),
							n(r.materialCostYtd),
						]),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

function initiatedByBlock(d: CppPdfData): Col {
	const sigW = COL_R / 4;
	const box = (title: string, signers: CppSigner[]): Col => ({
		width: sigW,
		table: {
			widths: tw([sigW]),
			heights: [54],
			body: [
				[
					{
						stack: [
							{ text: title, italics: true, fontSize: 6.2 },
							signerRow(signers, sigW - 4, 14, 2),
						],
						margin: [1, 1, 1, 0],
					} as TableCell,
				],
			],
		},
		layout: FORM_LAYOUT,
	});
	const proposer = d.proposer ? [d.proposer] : [];
	return {
		margin: [0, 5, 0, 0] as [number, number, number, number],
		stack: [
			{
				table: {
					widths: tw([COL_R]),
					body: [
						[c("Initiated By :", { fs: 6.5, fill: GREY_BAR, border: NONE })],
					],
				},
				layout: NO_PAD_LAYOUT_WITH_TEXT_PAD(),
			},
			{
				columns: [
					box("Proposed By:", proposer),
					box("Checked By:", d.checkedBy),
					box("Recomended By:", d.recommendedBy),
					box("Approved By:", d.approvedBy),
				],
				columnGap: 0,
			},
		],
	};
}

/* ---- committee / chairmen / MD / price feeding + checklist ---- */

function approvalBand(d: CppPdfData): Col {
	const bandW = W - COL_L - 4 - 118 - 4;
	const sectionH = 74;
	const sections: Array<{
		w: number;
		label: string;
		signers: CppSigner[];
		perRow: number;
	}> = [
		{
			w: 230,
			label: "CPP Committee Approval",
			signers: d.committee,
			perRow: 4,
		},
		{
			w: 76,
			label: "Approval from Alt Chairman",
			signers: d.altChairman,
			perRow: 1,
		},
		{
			w: 76,
			label: "Approval from CPP Chairman",
			signers: d.chairman,
			perRow: 1,
		},
		{
			w: 80,
			label: "Final Approval & Remarks",
			signers: d.managingDirector,
			perRow: 1,
		},
	];
	const used = sum(sections.map((s) => s.w));
	const feedingW = bandW - used;

	// Price feeding is done by the SCM head: the last WF1 approver on the form.
	const feeding = d.approvedBy.length
		? [d.approvedBy[d.approvedBy.length - 1]]
		: [];
	sections.push({
		w: feedingW,
		label: "Price Feeding Approval",
		signers: feeding,
		perRow: 1,
	});

	const cell = (s: (typeof sections)[number]): TableCell =>
		({
			columns: [
				{ width: 9, stack: [verticalLabel(s.label, 70)] },
				{
					width: s.w - 14,
					stack: [signerRow(s.signers, s.w - 14, 30, s.perRow)],
				},
			],
			columnGap: 0,
			margin: [1, 2, 0, 0],
		}) as TableCell;

	return {
		width: bandW,
		stack: [
			{
				table: {
					widths: tw([80, 120, bandW - 200]),
					body: [
						[
							c("Approving Authority :", { bold: true, fs: 5.8 }),
							c(d.approvingAuthority, {
								bold: true,
								italics: true,
								align: "center",
								fill: GREY_HEAD,
								fs: 6.4,
							}),
							c("", { border: NONE }),
						],
					],
				},
				layout: FORM_LAYOUT,
			},
			{
				table: {
					widths: tw(sections.map((s) => s.w)),
					heights: [sectionH],
					body: [sections.map(cell)],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

function checklistBlock(d: CppPdfData): Col {
	const wd = [90, 28];
	return {
		width: 118,
		table: {
			widths: tw(wd),
			body: [
				[
					c("Mandatory Check List", {
						bold: true,
						align: "center",
						fs: 6.6,
						border: [false, false, false, true],
					}),
					c("Yes/No/NA", {
						bold: true,
						align: "center",
						fs: 5.2,
						border: [false, false, false, true],
					}),
				],
				...d.checklist.map((i) => [
					c(i.label, { fs: 6, border: [false, false, false, true] }),
					c(i.value, {
						fill: BLUE,
						align: "center",
						fs: 5.2,
						border: [true, true, true, true],
					}),
				]),
			],
		},
		layout: FORM_LAYOUT,
	};
}

/* ---- bottom strip ---- */

function bottomStrip(d: CppPdfData): Col {
	const wd = [
		96,
		24,
		70,
		24,
		70,
		24,
		70,
		34,
		56,
		36,
		30,
		68,
		58,
		W - 96 - 24 - 70 - 24 - 70 - 24 - 70 - 34 - 56 - 36 - 30 - 68 - 58 - 4,
	];
	const t = (s: string, o: Opts = {}) => c(s, { fs: 6.4, ...o });
	return {
		margin: [2, 4, 2, 0] as [number, number, number, number],
		table: {
			widths: tw(wd),
			body: [
				[
					t("Approval dates and references :", { fs: 5.4 }),
					t("CPP"),
					t(d.cppDate ? dmy(d.cppDate, "/") : ""),
					t("MDO"),
					t(d.mdDate ? dmy(d.mdDate, "/") : ""),
					t("PFA"),
					t(""),
					t("Price Feeding", { fs: 5.6 }),
					t("Ref & Date", { italics: true, fs: 5, color: SOFT_TEXT }),
					t("POSA Run", { fs: 5.6 }),
					t("Yes", { align: "center" }),
					t("PO applicable for PO/SA", { fs: 5.2 }),
					t("As per annexure", { align: "center" }),
					c("THCM Price Approval Format - Version 26 (200615)", {
						fs: 3.8,
						color: SOFT_TEXT,
						border: NONE,
						align: "right",
					}),
				],
			],
		},
		layout: FORM_LAYOUT,
	};
}

function buildForm(d: CppPdfData): Col {
	const inner: Content[] = [
		headerBand(
			"DIRECT/ INDIRECT MATERIAL/ SPARE PARTS - PRICE APPROVAL",
			"Dharwad/ Kharagpur /Spare",
			"Format no-THX11-D07-F02 Ver 1.5",
		),
		hRule(W - 3),
		reasonRow(d),
		{
			margin: [2, 0, 2, 0] as [number, number, number, number],
			columns: [
				{
					width: LEFT_W,
					stack: [
						grey("Purchasing Details :", LEFT_W),
						purchasingTable(d),
						lowerLeftTables(d),
					],
				},
				{ width: 6, text: "" },
				{ width: RIGHT_W, stack: [financialBlock(d), otherDataBlock(d)] },
			],
			columnGap: 0,
		},
		{
			margin: [2, 6, 2, 0] as [number, number, number, number],
			columns: [
				leftColumnTop(d),
				{ width: 4, text: "" },
				justificationBlock(d),
				{ width: 4, text: "" },
				{ width: COL_R, stack: [trackerBlock(d), initiatedByBlock(d)] },
			],
			columnGap: 0,
		},
		{
			margin: [2, 4, 2, 0] as [number, number, number, number],
			columns: [
				leftColumnBottom(d),
				{ width: 4, text: "" },
				{
					width: W - COL_L - 4 - 4,
					columns: [approvalBand(d), { width: 4, text: "" }, checklistBlock(d)],
					columnGap: 0,
				},
			],
			columnGap: 0,
		},
		bottomStrip(d),
		{
			text: "for multiple pt. no's please refer to summary sheet",
			italics: true,
			fontSize: 4,
			color: SOFT_TEXT,
			alignment: "center",
			margin: [0, 1, 0, 2],
		},
	];

	return {
		table: {
			widths: [W],
			body: [[{ stack: inner, margin: [0, 0, 0, 0] } as TableCell]],
		},
		layout: OUTER_LAYOUT,
	};
}

/* =============================== PAGE 2+ — F07 ============================== */

const S_COLS = [
	20, 28, 100, 52, 126, 24, 42, 42, 36, 64, 46, 28, 46, 28, 28, 54, 32,
]; // = 796
const S_FS = 6.2;

const sc = (text: string, o: Opts = {}) => c(text, { fs: S_FS, ...o });

function pirAsSummary(rows: CppPirRow[]): CppSummaryLine[] {
	return rows.map(
		(r, i): CppSummaryRow => ({
			kind: "part",
			slNo: r.sr ?? i + 1,
			plant: r.plant,
			model: "",
			partNo: r.partNo,
			description: r.description,
			uom: "",
			existingPrice: null,
			newPrice: r.price,
			difference: null,
			currentPo: r.poForPosa,
			effectiveDate: r.validFrom,
			rcvdQty: null,
			actualImpact: null,
			abpVol: null,
			qtyPerMc: null,
			annualisedImpact: null,
			pctChange: null,
		}),
	);
}

function summarySheet(d: CppPdfData): Content[] {
	const lines: CppSummaryLine[] =
		d.parts.summary.length > 0 ? d.parts.summary : pirAsSummary(d.parts.pir);
	if (lines.length === 0) return [];

	const plantMark = (name: string, label: string): Col => ({
		columns: [
			{
				text: label,
				bold: d.applicablePlants.some((p) => p.toUpperCase() === name),
				fontSize: 6.6,
				width: "auto",
			},
			...(d.applicablePlants.some((p) => p.toUpperCase() === name)
				? [
						{
							...tick(5.5),
							margin: [1, 0.5, 0, 0] as [number, number, number, number],
						},
					]
				: []),
		],
		width: "auto",
	});

	const infoLeftW = 360;
	const info: Col = {
		margin: [0, 4, 0, 5] as [number, number, number, number],
		columns: [
			{
				width: infoLeftW,
				table: {
					widths: tw([60, infoLeftW - 60]),
					body: [
						[
							c("Supplier Name :", { bold: true, fs: 6.6 }),
							c(d.suppliers.recommended.name, { fs: 6.6 }),
						],
						[
							c("Supplier Code :", { bold: true, fs: 6.6 }),
							c(d.suppliers.recommended.code, { fs: 6.6 }),
						],
					],
				},
				layout: FORM_LAYOUT,
			},
			{ width: "*", text: "" },
			{
				width: 250,
				table: {
					widths: tw([60, 190]),
					body: [
						[
							c("Plant :", {
								bold: true,
								fs: 6.6,
								border: [false, false, false, false],
							}),
							{
								columns: [
									plantMark("DWD", "DWD"),
									{ text: "  |  ", fontSize: 6.6, width: "auto" },
									plantMark("KGP", "KGP"),
									{ text: "  |  ", fontSize: 6.6, width: "auto" },
									plantMark("SPARE", "SPARE"),
								],
								columnGap: 0,
								alignment: "right",
								border: [false, false, false, false],
							} as TableCell,
						],
						[
							c("Approval Ref. :", { bold: true, fs: 6.6 }),
							c(d.referenceNumber, { fs: 6.6 }),
						],
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};

	const H = (t: string, o: Opts = {}) =>
		sc(t, { bold: true, align: "center", fill: GREY_HEAD, ...o });
	const groupRow: TableCell[] = [
		...[0, 1, 2, 3, 4, 5].map(() => sc("", { border: NONE })),
		...spanned(3, H("Price Revision Data", { fill: undefined })),
		sc("", { border: NONE }),
		sc("", { border: NONE }),
		...spanned(2, H("For Retro. Price Impact", { fill: undefined })),
		...spanned(3, H("For Annualised Impact", { fill: undefined })),
		sc("", { border: NONE }),
	];
	const headRow: TableCell[] = [
		H("Sl. No."),
		H("Plant"),
		H("Model"),
		H("Part No."),
		H("Description"),
		H("UOM"),
		H("Existing Price\n(in INR)"),
		H("New Price w.e.f.\n(in INR)"),
		H("Difference\n(in INR)"),
		H("Current PO applicable for PO/SA updation"),
		H("Effective Date"),
		H("Rcvd Qty"),
		H("Actual Impact"),
		H("ABP Vol."),
		H("Qty per m/c"),
		H("Annualised Impact"),
		H("% Change"),
	];

	let serial = 0;
	const body: TableCell[][] = [groupRow, headRow];
	for (const line of lines) {
		if (line.kind === "heading") {
			body.push([...spanned(S_COLS.length, sc(line.text, { bold: true }))]);
			continue;
		}
		serial += 1;
		const p = line;
		body.push([
			sc(String(p.slNo ?? serial), { align: "center" }),
			sc(p.plant, { align: "center" }),
			sc(p.model),
			sc(p.partNo),
			sc(p.description),
			sc(p.uom, { align: "center" }),
			sc(fmtNum(p.existingPrice), { align: "right" }),
			sc(fmtNum(p.newPrice), { align: "right" }),
			sc(fmtNum(p.difference), { align: "right" }),
			sc(p.currentPo, { align: "center" }),
			sc(p.effectiveDate, { align: "center" }),
			sc(fmtNum(p.rcvdQty), { align: "right" }),
			sc(fmtNum(p.actualImpact), { align: "right" }),
			sc(fmtNum(p.abpVol), { align: "right" }),
			sc(fmtNum(p.qtyPerMc), { align: "right" }),
			sc(fmtNum(p.annualisedImpact), { align: "right" }),
			sc(fmtPct(p.pctChange, 1), { align: "right" }),
		]);
	}

	const partTable: Col = {
		table: { headerRows: 2, dontBreakRows: true, widths: tw(S_COLS), body },
		layout: {
			...FORM_LAYOUT,
			paddingTop: () => 0.9,
			paddingBottom: () => 0.9,
			// the group-label row has no frame of its own
			hLineWidth: (i: number) => (i === 0 ? 0 : LINE),
		},
	};

	// A → / B →  (totals) under the two impact columns
	const A = d.impact.actual;
	const B = d.impact.annual;
	const lead = sum(S_COLS.slice(0, 11));
	const totals: Col = {
		margin: [0, 2, 0, 0] as [number, number, number, number],
		table: {
			widths: tw([
				lead,
				S_COLS[11],
				S_COLS[12],
				S_COLS[13] + S_COLS[14],
				S_COLS[15],
				S_COLS[16],
			]),
			body: [
				[
					c("", { border: NONE }),
					labelWithArrow("A", {
						bold: true,
						align: "right",
						border: NONE,
						fs: 6.6,
					}),
					c(fmtNum(A), {
						bold: true,
						align: "right",
						fs: 6.6,
						border: [false, true, false, true],
					}),
					labelWithArrow("B", {
						bold: true,
						align: "right",
						border: NONE,
						fs: 6.6,
					}),
					c(fmtNum(B), {
						bold: true,
						align: "right",
						fs: 6.6,
						border: [false, true, false, true],
					}),
					c("", { border: NONE }),
				],
			],
		},
		layout: { ...FORM_LAYOUT, hLineWidth: () => 1, vLineWidth: () => 0 },
	};

	const changeBox: Col = {
		margin: [S_COLS.slice(0, 5).reduce((a, b) => a + b, 0) - 60, 4, 0, 0] as [
			number,
			number,
			number,
			number,
		],
		table: {
			widths: tw([190, 54, 66]),
			body: [
				[
					c("", { border: NONE }),
					...spanned(
						2,
						c("Current. Change", { bold: true, align: "center", fs: 6.2 }),
					),
				],
				[
					c("", { border: NONE }),
					c("in %age", { bold: true, fs: 6 }),
					c("in Value INR", { bold: true, fs: 6 }),
				],
				[
					c("Actual (only for retrospective change) (A)", {
						bold: true,
						align: "right",
						fs: 6.2,
					}),
					c(fmtPct(d.impact.actualPct), { align: "right", fs: 6.2 }),
					c(fmtNum(A), { align: "right", fs: 6.2 }),
				],
				[
					c("Annualised (based on ABP) (B)", {
						bold: true,
						align: "right",
						fs: 6.2,
					}),
					c(fmtPct(d.impact.annualPct), { align: "right", fs: 6.2 }),
					c(fmtNum(B), { align: "right", fs: 6.2 }),
				],
			],
		},
		layout: FORM_LAYOUT,
	};

	const sig = (title: string, s: CppSigner[], left: number): Col => ({
		width: 150,
		stack: [
			{ text: title, italics: true, fontSize: 6.2 },
			{ text: " ", margin: [0, 8, 0, 0] },
			...(s.length
				? s.map((p) => ({
						stack: [
							{ text: p.name, bold: true, italics: true, fontSize: 6 },
							{
								text: p.designation ? `(${p.designation})` : " ",
								bold: true,
								italics: true,
								fontSize: 5.6,
							},
						],
					}))
				: [{ text: " " }]),
		],
		margin: [left, 0, 0, 0] as [number, number, number, number],
	});
	const signatures: Col = {
		margin: [0, 8, 0, 0] as [number, number, number, number],
		columns: [
			sig("Prepared By", d.proposer ? [d.proposer] : [], 60),
			sig("Checked By", d.checkedBy, 60),
			sig("Reviewed By", d.recommendedBy, 40),
			sig(
				"Approved By",
				d.approvedBy.length ? [d.approvedBy[d.approvedBy.length - 1]] : [],
				60,
			),
		],
		columnGap: 0,
	};

	return [
		{ text: "", pageBreak: "before" },
		headerBand(
			"Summary Sheet for Price Changes",
			"Format no.THX11-D07-F07 Ver 1.5",
			"",
		),
		hRule(W, 0),
		info,
		partTable,
		// keep totals + signatures together on the last page
		{ unbreakable: true, stack: [totals, changeBox, signatures, hRule(W, 4)] },
	];
}

/* ===================== LAST PAGES — WORKFLOW + AUDIT TRAIL ==================== */

const A_FS = 7;
const TABLE_LAYOUT = {
	...FORM_LAYOUT,
	paddingLeft: () => 3,
	paddingRight: () => 3,
	paddingTop: () => 2,
	paddingBottom: () => 2,
};

/** Like tw(), for TABLE_LAYOUT's wider cell padding (3 + 3). */
const tw6 = (widths: number[]): number[] =>
	widths.map((w) => Math.max(w - 6, 1));

const ac = (text: string, o: Opts = {}) => c(text, { fs: A_FS, ...o });
const ah = (text: string) =>
	ac(text, { bold: true, fill: GREY_HEAD, align: "center" });

const PHASE_LABEL: Record<CppWorkflowRow["phase"], string> = {
	WF1: "WF1 · Plant / SCM",
	WF2: "WF2 · CPP committee",
};

/** What a row's status means for the reader, using the stage status too. */
function approvalStatusText(row: CppWorkflowRow): string {
	const approval = row.status.toUpperCase();
	const stage = row.stageStatus.toUpperCase();
	if (approval === "PENDING") {
		if (stage === "APPROVED") return "Not needed";
		if (stage === "IN_PROGRESS") return "Pending";
		return "Not started";
	}
	return statusLabel(approval);
}

function workflowTable(d: CppPdfData): Content {
	// # | Workflow | Stage | Approver | Designation | Email | Status | Acted on
	const widths = [22, 78, 200, 120, 112, 140, 62, 64]; // = 798
	const body: TableCell[][] = [
		[
			ah("#"),
			ah("Workflow"),
			ah("Stage"),
			ah("Approver"),
			ah("Designation"),
			ah("Email"),
			ah("Status"),
			ah("Acted on"),
		],
	];
	if (d.workflowRows.length === 0) {
		body.push([
			...spanned(
				widths.length,
				ac("No approval workflow has started for this request yet.", {
					italics: true,
					color: SOFT_TEXT,
					align: "center",
				}),
			),
		]);
	} else {
		let lastStage = -1;
		d.workflowRows.forEach((r) => {
			const firstOfStage = r.stageOrder !== lastStage;
			lastStage = r.stageOrder;
			// The stage is printed once; its other approvers follow on plain rows.
			body.push([
				ac(firstOfStage ? String(r.stageOrder) : "", { align: "center" }),
				ac(firstOfStage ? PHASE_LABEL[r.phase] : ""),
				ac(firstOfStage ? r.stageName : "", { bold: firstOfStage }),
				ac(r.approver),
				ac(r.designation),
				ac(r.email),
				ac(approvalStatusText(r), { align: "center" }),
				ac(istDateTime(r.actedAt), { align: "center" }),
			]);
		});
	}
	return {
		table: { headerRows: 1, dontBreakRows: true, widths: tw6(widths), body },
		layout: TABLE_LAYOUT,
	};
}

function auditTable(d: CppPdfData): Content {
	// # | Date & time | Action | By | Stage | Remarks
	const widths = [22, 80, 130, 130, 180, 256]; // = 798
	const body: TableCell[][] = [
		[
			ah("#"),
			ah("Date & time (IST)"),
			ah("Action"),
			ah("By"),
			ah("Stage"),
			ah("Remarks"),
		],
	];
	if (d.auditTrail.length === 0) {
		body.push([
			...spanned(
				widths.length,
				ac("No activity recorded yet.", {
					italics: true,
					color: SOFT_TEXT,
					align: "center",
				}),
			),
		]);
	} else {
		d.auditTrail.forEach((r, i) => {
			body.push([
				ac(String(i + 1), { align: "center" }),
				ac(istDateTime(r.at), { align: "center" }),
				ac(r.action),
				ac(r.by),
				ac(r.stage),
				ac(r.remarks),
			]);
		});
	}
	return {
		table: { headerRows: 1, dontBreakRows: true, widths: tw6(widths), body },
		layout: TABLE_LAYOUT,
	};
}

function workflowAndAudit(d: CppPdfData): Content[] {
	return [
		{ text: "", pageBreak: "before" },
		headerBand(
			"Approval Workflow & Audit Trail",
			`Approval Ref. : ${d.referenceNumber}`,
			`Generated on ${istDateTime(d.generatedAt)} IST`,
		),
		hRule(W, 0),
		{
			margin: [0, 6, 0, 3] as [number, number, number, number],
			...(grey("Approval Workflow", W, 7.5) as object),
		} as Content,
		workflowTable(d),
		{
			margin: [0, 12, 0, 3] as [number, number, number, number],
			...(grey("Audit Trail", W, 7.5) as object),
		} as Content,
		auditTable(d),
	];
}

/* ================================== builder ================================== */

export function buildCppDocDefinition(data: CppPdfData): TDocumentDefinitions {
	return {
		pageSize: "A4",
		pageOrientation: "landscape",
		pageMargins: [
			PAGE_MARGIN_X,
			PAGE_MARGIN_TOP,
			PAGE_MARGIN_X,
			PAGE_MARGIN_BOTTOM,
		],
		styles: STYLES,
		defaultStyle: DEFAULT_STYLE,
		...(LOGO_DATA_URI ? { images: { logo: LOGO_DATA_URI } } : {}),
		info: {
			title: `CPP ${data.referenceNumber}`,
			subject: "Direct / Indirect Material / Spare Parts - Price Approval",
		},
		content: [
			buildForm(data),
			...summarySheet(data),
			...workflowAndAudit(data),
		],
	};
}

import type {
	Content,
	ContentCanvas,
	StyleDictionary,
	Style,
	TableCell,
	TDocumentDefinitions,
} from "pdfmake/interfaces";

import { LOGO_DATA_URI } from "@vendor-onboarding/vendorOnboardingLogo";

import type {
	CppPdfData,
	CppSigner,
	ImpactRow,
	PlantImpact,
} from "./cppAssembler";
import type { CppPirRow, CppSummaryLine, CppSummaryRow } from "./cppPartRows";

// ─────────────────────────────────────────────────────────────────────────────
// CPP — DOC DEFINITION (A4 landscape)
//
// Page 1  Format no. THX11-D07-F02 Ver 1.5  "Direct / Indirect Material /
//         Spare Parts – Price Approval"   (the form)
// Page 2+ Format no. THX11-D07-F07 Ver 1.5  "Summary Sheet for Price Changes"
//         (only when the uploaded Excel has part rows)
// Supplier annexures (uploaded PDFs / images) are appended by the PDF service.
//
// Everything printed comes from CppPdfData. Cells the data cannot fill stay
// blank, exactly like an unsigned paper form — nothing is invented.
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
const FS_BIG = 7;

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

const fmtNum = (n: number | null | undefined): string => {
	if (n === null || n === undefined || !Number.isFinite(n)) return "";
	return n.toLocaleString("en-IN", {
		minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
		maximumFractionDigits: 2,
	});
};

const fmtPct = (fraction: number | null | undefined, dp = 2): string =>
	fraction === null || fraction === undefined || !Number.isFinite(fraction)
		? ""
		: `${(fraction * 100).toFixed(dp)}%`;

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

const grey = (title: string, width: number): Content => ({
	table: {
		widths: tw([width]),
		body: [[c(title, { fs: 6.5, fill: GREY_BAR, border: NONE })]],
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
	// the "for more than 5 parts" note sits in the empty top-left area
	(supplierRows[1][0] as TableCell & { text: string }) = {
		text: "For more than 5 parts, please use summary sheet",
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

	// Part rows live in the enclosure (the summary sheet), so the form refers to it
	// exactly like the paper original: "As per encl" in every part cell.
	const uomSet = new Set(
		d.parts.summary
			.filter((l): l is CppSummaryRow => l.kind === "part")
			.map((p) => p.uom)
			.filter(Boolean),
	);
	const uom = uomSet.size === 1 ? [...uomSet][0] : "";
	const encl = "As per encl";

	const first: TableCell[] = [
		c(encl),
		c(""),
		c(uom, { align: "center" }),
		c(encl, { align: "center", fs: 5 }),
		c(encl, { align: "center", fs: 5 }),
		c(""),
		c(""),
		c(""),
		c(""),
		...spanned(3, c(encl, { align: "center" })),
	];
	const body: TableCell[][] = [
		...supplierRows,
		head1,
		head2,
		first,
		...Array.from({ length: 4 }, () => emptyRow(PART_COLS.length)),
	];

	return {
		table: { widths: tw(PART_COLS), body },
		layout: FORM_LAYOUT,
	};
}

function lowerLeftTables(): Col {
	const AMORT = [40, 30, 38, 26, 34]; // 168
	const PM = [34, 34, 36, 36]; // 140
	const VOL = [100, 46, 46, 46]; // 238
	const gap = LEFT_W - sum(AMORT) - sum(PM) - sum(VOL);
	const g = gap / 2;

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
						emptyRow(5),
						emptyRow(5),
						emptyRow(5),
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
						emptyRow(4),
						emptyRow(4),
						emptyRow(4),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
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
						[c("Rcvd Qty. (Till Date) = a", { fs: 5.4 }), c(""), c(""), c("")],
						[c("Remaining Qty. = b", { fs: 5.4 }), c(""), c(""), c("")],
						[
							...spanned(
								4,
								c("For Annualised", { bold: true, fill: GREY_HEAD }),
							),
						],
						[c("Qty./mc x ABP No's = c", { fs: 5.4 }), c(""), c(""), c("")],
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
	const impact = d.impact;
	const plantImpactRow = (key: ImpactRow, label: string): TableCell[] => {
		const p: PlantImpact = d.impactByPlant[key];
		const n = {
			fs: 6.4,
			align: "right" as const,
			margin: [0, 3.5, 0, 3.5] as [number, number, number, number],
		};
		return [
			rowLabel(label),
			c(fmtNum(p.actual), n),
			c(fmtPct(p.actualPct, 1), n),
			c(p.annual === null ? "" : fmtNum(p.annual), n),
			c(fmtPct(p.annualPct), n),
		];
	};
	const total: TableCell[] = [
		c("Total", { bold: true, fs: 6.4, align: "center", margin: [0, 2, 0, 2] }),
		c(fmtNum(impact.actual), {
			bold: true,
			fs: 6.6,
			align: "right",
			margin: [0, 2, 0, 2],
		}),
		c(fmtPct(impact.actualPct, 1), {
			bold: true,
			fs: 6.4,
			align: "right",
			margin: [0, 2, 0, 2],
		}),
		c(impact.annual === null ? "" : `Rs. ${fmtNum(impact.annual)}`, {
			bold: true,
			fs: 6.6,
			align: "right",
			margin: [0, 2, 0, 2],
		}),
		c(fmtPct(impact.annualPct), {
			bold: true,
			fs: 6.4,
			align: "right",
			margin: [0, 2, 0, 2],
		}),
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
						plantImpactRow("KGP", "KGP"),
						plantImpactRow("DWD", "DWD"),
						plantImpactRow("SPARE", "SPARE"),
						total,
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

function otherDataBlock(): Col {
	const wd = [55, 90, RIGHT_W - 55 - 90 - 0];
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
						emptyRow(3),
						emptyRow(3),
						emptyRow(3),
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
	const chosen = new Set(
		d.applicablePlants.map((p) => p.toUpperCase().replace(/\s+/g, " ")),
	);
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
					c(chosen.has(name) ? "Yes" : "No", {
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

	const cond = (code: string, name: string) => ({
		code,
		name,
		on: d.pricingCondition.toUpperCase() === code,
	});
	const conditionTable: Col = {
		table: {
			widths: tw([38, 0, 0].length ? [60, 74] : []),
			body: [
				[
					labelWithTick("PB00  Regular", cond("PB00", "").on, { bold: true }),
					labelWithTick("PB50  Amortised", cond("PB50", "").on, { bold: true }),
				],
				[
					labelWithTick("PB25  One Time", cond("PB25", "").on, { bold: true }),
					labelWithTick("PB75  Provisional", cond("PB75", "").on, {
						bold: true,
					}),
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
	const forSpares: Col = {
		table: {
			widths: tw(lw),
			body: [
				[
					c("Inco Terms", { bold: true, fill: BLUE }),
					c(d.isSpare ? "DWD/KGP Warehouse" : "", { fill: BLUE }),
				],
				[c("P&F (%age) :", { bold: true, fill: BLUE }), c("", { fill: BLUE })],
				[c("Tax Code :", { bold: true, fill: BLUE }), c("", { fill: BLUE })],
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

/* ---- justification ---- */

function fitJustification(text: string): { text: string; fs: number } {
	const t = text.replace(/\r\n/g, "\n").trim();
	if (t.length <= 650) return { text: t, fs: 8.4 };
	if (t.length <= 1050) return { text: t, fs: 7 };
	if (t.length <= 1750) return { text: t, fs: 6 };
	return { text: `${t.slice(0, 1700).trimEnd()} …`, fs: 6 };
}

const MID_W = 210;
const BOX_H = 150;

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
								margin: [2, 2, 2, 0],
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

function trackerBlock(): Col {
	const wd = [62, 56, 78, 66, 64, COL_R - 62 - 56 - 78 - 66 - 64 - 0];
	const heads = [
		"Model",
		"Per Machine Impact",
		"Budgeted increase in Price (Per M/c – FY16)",
		"Status YTD ( FY19)",
		"Budgeted Material Cost",
		"Material Cost YTD",
	];
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
								fs: 5.6,
								margin: [0, 2, 0, 2],
							}),
						),
						...Array.from({ length: 6 }, () => emptyRow(6)),
					],
				},
				layout: FORM_LAYOUT,
			},
		],
	};
}

function initiatedByBlock(d: CppPdfData): Col {
	const sigW = COL_R / 4;
	const box = (
		title: string,
		signers: CppSigner[],
		widthTitleItalic = true,
	): Col => ({
		width: sigW,
		table: {
			widths: tw([sigW]),
			heights: [54],
			body: [
				[
					{
						stack: [
							{ text: title, italics: widthTitleItalic, fontSize: 6.2 },
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
					widths: tw([80, 40, bandW - 120]),
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
						lowerLeftTables(),
					],
				},
				{ width: 6, text: "" },
				{ width: RIGHT_W, stack: [financialBlock(d), otherDataBlock()] },
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
				{ width: COL_R, stack: [trackerBlock(), initiatedByBlock(d)] },
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
			widths: tw(
				[
					lead,
					S_COLS[11] + 0,
					S_COLS[12],
					S_COLS[13] + S_COLS[14] - 0,
					S_COLS[15],
					S_COLS[16],
				].map((n, i) => (i === 3 ? S_COLS[13] + S_COLS[14] : n)),
			),
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
		absolutePosition: undefined,
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
		content: [buildForm(data), ...summarySheet(data)],
	};
}

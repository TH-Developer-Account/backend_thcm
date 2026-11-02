import type {
	TDocumentDefinitions,
	Content,
	TableCell,
	StyleDictionary,
	Style,
} from "pdfmake/interfaces";
import { MedicalClaimPdfData } from "./mediclaimAssembler";
import {
	displayValue,
	displayBoolean,
	displayDate,
	formatDateTimeSlash,
	formatStatusLabel,
} from "@pdf/pdfFieldFormatter";
import { FINANCIAL_YEAR_ELIGIBILITY } from "./mediclaim.eligibility";

// ─────────────────────────────────────────────────────────────────────────────
// MEDICAL CLAIM — DOC DEFINITION BUILDER
//
// Pure function: MedicalClaimPdfData in, pdfmake TDocumentDefinitions out.
// No I/O, no S3, no rendering — just layout. Mirrors
// vendorOnboardingDocDofination.ts (same constants, table layout, section
// bars, header and footer) so the two PDF types stay visually identical.
// ─────────────────────────────────────────────────────────────────────────────

// Base64 data URI of the company logo, e.g. "data:image/png;base64,iVBOR...".
// Leave empty to fall back to the company name text in the header.
// To match the vendor PDF, point this at the same logo module instead:
//   import { LOGO_DATA_URI } from "<path>/vendorOnboardingLogo";
const LOGO_DATA_URI = "";

const DOCUMENT_TITLE = "Medical Reimbursement Claim";

const BLACK = "#000000";
const GREY_TEXT = "#555555"; // footer only

// ── spacing & layout constants — tweak these to adjust the PDF ──────────
// All values are in pdfmake points (pt).

// Table cell padding (applies to every table in the document).
// Bottom is smaller than top because line height already adds space
// under the text.
const CELL_PADDING_LEFT = 5;
const CELL_PADDING_RIGHT = 5;
const CELL_PADDING_TOP = 5;
const CELL_PADDING_BOTTOM = 2;

// Table border thickness.
const TABLE_LINE_WIDTH = 0.5;

// Vertical gap between one table and the next.
const SECTION_GAP = 10;

// Page margins: left, top, right, bottom. The top margin must leave room
// for the header; the bottom margin must leave room for the footer.
const PAGE_MARGIN_LEFT = 30;
const PAGE_MARGIN_TOP = 44;
const PAGE_MARGIN_RIGHT = 30;
const PAGE_MARGIN_BOTTOM = 40;

// Header block position (left/right should normally match the page margins).
const HEADER_MARGIN_LEFT = 30;
const HEADER_MARGIN_TOP = 10;
const HEADER_MARGIN_RIGHT = 30;

// Footer block position (left/right should normally match the page margins).
const FOOTER_MARGIN_LEFT = 30;
const FOOTER_MARGIN_RIGHT = 30;
const FOOTER_MARGIN_BOTTOM = 14;

// Space above the company name and the title inside the header.
const HEADER_COMPANY_MARGIN_TOP = 5;
const HEADER_TITLE_MARGIN_TOP = 8;

// Both side columns share one fixed width so the title column stays
// centred on the page whether or not a logo is present.
const HEADER_SIDE_WIDTH = 150;

// Line height multiplier for all text. Lower = tighter rows.
const TEXT_LINE_HEIGHT = 1.15;

const FIELD_COLS = 4;
const FIELD_WIDTHS = ["17%", "33%", "17%", "33%"];

const TABLE_LAYOUT = {
	hLineWidth: () => TABLE_LINE_WIDTH,
	vLineWidth: () => TABLE_LINE_WIDTH,
	hLineColor: () => BLACK,
	vLineColor: () => BLACK,
	paddingLeft: () => CELL_PADDING_LEFT,
	paddingRight: () => CELL_PADDING_RIGHT,
	paddingTop: () => CELL_PADDING_TOP,
	paddingBottom: () => CELL_PADDING_BOTTOM,
};

// Explicitly typed as StyleDictionary/Style rather than `as const` — `as
// const` makes nested tuples readonly, which pdfmake's Margins type rejects.
const STYLES: StyleDictionary = {
	letterheadCompany: {
		fontSize: 9,
		bold: true,
		color: BLACK,
		margin: [0, HEADER_COMPANY_MARGIN_TOP, 0, 0],
	},
	letterheadTitle: {
		fontSize: 10,
		bold: true,
		color: BLACK,
		decoration: "underline",
		margin: [0, HEADER_TITLE_MARGIN_TOP, 0, 0],
	},
	footerText: { fontSize: 8, color: GREY_TEXT },
};

const DEFAULT_STYLE: Style = {
	font: "Helvetica",
	fontSize: 9,
	lineHeight: TEXT_LINE_HEIGHT,
	color: BLACK,
};

// ── formatting ──────────────────────────────────────────────────────────
// Indian digit grouping (1,23,456.00). Written as "Rs." rather than the ₹
// symbol: pdfmake's built-in Helvetica has no ₹ glyph, so it would render
// as a blank/garbled character. Swap back if a custom font with ₹ is registered.
const displayAmount = (value: number | null): string =>
	value === null
		? "—"
		: `Rs. ${value.toLocaleString("en-IN", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			})}`;

// ── cell / row primitives ───────────────────────────────────────────────
// Table cells are typed TableCell (not Content): TableCell carries colSpan.

// pdfmake needs `colSpan` cells followed by placeholder cells.
function filler(count: number): TableCell[] {
	return Array.from({ length: count }, (): TableCell => ({ text: "" }));
}

function sectionBar(title: string, cols: number): TableCell[] {
	return [
		{ text: title, colSpan: cols, bold: true, fontSize: 10.5 },
		...filler(cols - 1),
	];
}

function labelCell(text: string): TableCell {
	return { text, bold: true };
}

function headCell(text: string, alignment?: "right"): TableCell {
	return alignment ? { text, bold: true, alignment } : { text, bold: true };
}

// ── field sections: label | value | label | value ───────────────────────
// Fields flow two per row. A field marked `full` (or an odd one left over)
// takes the whole row, with its value spanning the three remaining columns.

interface Field {
	label: string;
	value: string;
	full?: boolean;
}

function field(label: string, value: string, full = false): Field {
	return { label, value, full };
}

function fullWidthRow(f: Field): TableCell[] {
	return [
		labelCell(f.label),
		{ text: f.value, colSpan: FIELD_COLS - 1 },
		...filler(FIELD_COLS - 2),
	];
}

function buildFieldTable(title: string, fields: Field[]): Content {
	const body: TableCell[][] = [sectionBar(title, FIELD_COLS)];
	let pending: Field | null = null;

	for (const f of fields) {
		if (f.full) {
			if (pending) {
				body.push(fullWidthRow(pending));
				pending = null;
			}
			body.push(fullWidthRow(f));
		} else if (pending) {
			body.push([
				labelCell(pending.label),
				{ text: pending.value },
				labelCell(f.label),
				{ text: f.value },
			]);
			pending = null;
		} else {
			pending = f;
		}
	}
	if (pending) body.push(fullWidthRow(pending));

	return {
		table: {
			headerRows: 1,
			dontBreakRows: true,
			widths: FIELD_WIDTHS,
			body,
		},
		layout: TABLE_LAYOUT,
		margin: [0, 0, 0, SECTION_GAP],
	};
}

// ── section builders ────────────────────────────────────────────────────

function buildClaimDetailsSection(data: MedicalClaimPdfData): Content[] {
	const c = data.claim;
	return [
		buildFieldTable("Claim Details", [
			field("Reference No.", displayValue(c.referenceNumber)),
			field("Submitted On", formatDateTimeSlash(c.submittedAt)),
			field("Employee Name", displayValue(c.employeeName)),
			field("Ticket Number", displayValue(c.ticketNumber)),
			field("Grade", displayValue(c.grade)),
			field("Location", displayValue(c.location)),
			field("Mobile", displayValue(c.mobile)),
			field("Email", displayValue(c.email)),
			field("Patient Name", displayValue(c.patientName)),
			field("Claim Cover", displayValue(c.claimCover)),
			field("Spouse Name", displayValue(c.spouseName)),
			field("Medical Advance", displayAmount(c.medicalAdvanceTaken)),
		]),
	];
}

// Label | Amount. Label text is long ("Already Settled (this financial year) —
// Non-Hospitalisation"), so this uses a 2-column table instead of the 4-column
// field grid. `indent` rows ("of which …") are inset under their parent total.
interface AmountRow {
	label: string;
	value: string;
	indent?: boolean;
	bold?: boolean;
}

function buildAmountsSection(data: MedicalClaimPdfData): Content[] {
	const a = data.amounts;

	// Grades with hospitalisation cover (EG) have two separate buckets, so the
	// labels say which one a figure belongs to. Other grades keep plain labels.
	const hasHospitalisation =
		a.hospitalisationEligibleAmount !== null ||
		a.hospitalisationAlreadySettled !== null;
	const period = FINANCIAL_YEAR_ELIGIBILITY
		? "this financial year"
		: "this year";
	const bucketSuffix = hasHospitalisation ? " — Non-Hospitalisation" : "";

	const rows: AmountRow[] = [
		{
			label: `Eligible Amount${bucketSuffix}`,
			value: displayAmount(a.eligibleAmount),
		},
		{
			label: `Already Settled (${period})${bucketSuffix}`,
			value: displayAmount(a.alreadySettled),
		},
		...(hasHospitalisation
			? [
					{
						label: "Eligible Amount — Hospitalisation",
						value: displayAmount(a.hospitalisationEligibleAmount),
					},
					{
						label: `Already Settled (${period}) — Hospitalisation`,
						value: displayAmount(a.hospitalisationAlreadySettled),
					},
				]
			: []),
		{
			label: "Total Claimed",
			value: displayAmount(a.totalClaimed),
			bold: true,
		},
		...(hasHospitalisation
			? [
					{
						label: "of which Non-Hospitalisation",
						value: displayAmount(a.claimedNonHospitalisation),
						indent: true,
					},
					{
						label: "of which Hospitalisation",
						value: displayAmount(a.claimedHospitalisation),
						indent: true,
					},
				]
			: []),
		{
			label: "Total Approved",
			value: displayAmount(a.totalApproved),
			bold: true,
		},
	];

	const body: TableCell[][] = [
		sectionBar("Amounts", 2),
		...rows.map((row): TableCell[] => [
			{
				text: row.label,
				bold: row.bold ?? !row.indent,
				...(row.indent ? { leadingIndent: 12 } : {}),
			},
			{ text: row.value, alignment: "right", bold: row.bold ?? false },
		]),
	];

	return [
		{
			table: {
				headerRows: 1,
				dontBreakRows: true,
				widths: ["65%", "35%"],
				body,
			},
			layout: TABLE_LAYOUT,
			margin: [0, 0, 0, SECTION_GAP],
		},
	];
}

// S.No | Claim Head | Bill No. | Bill Name | Bill Date | Claimed | Approved Amt | Approved
function buildBillsSection(data: MedicalClaimPdfData): Content[] {
	const COLS = 8;
	const body: TableCell[][] = [sectionBar("Claim Bills", COLS)];

	if (data.bills.length > 0) {
		body.push([
			headCell("S.No"),
			headCell("Claim Head"),
			headCell("Bill No."),
			headCell("Bill Name"),
			headCell("Bill Date"),
			headCell("Claimed", "right"),
			headCell("Approved Amt", "right"),
			headCell("Approved"),
		]);
		data.bills.forEach((bill, index) =>
			body.push([
				{ text: String(index + 1) },
				{ text: bill.claimHead },
				{ text: displayValue(bill.billNo) },
				{ text: displayValue(bill.billName) },
				{ text: displayDate(bill.billDate) },
				{ text: displayAmount(bill.amount), alignment: "right" },
				{ text: displayAmount(bill.approvedClaimAmount), alignment: "right" },
				{ text: displayBoolean(bill.approved) },
			]),
		);
	} else {
		body.push([
			{ text: "No claim bills attached.", italics: true, colSpan: COLS },
			...filler(COLS - 1),
		]);
	}

	return [
		{
			table: {
				headerRows: data.bills.length > 0 ? 2 : 1,
				dontBreakRows: true,
				widths: ["6%", "16%", "10%", "16%", "11%", "13%", "15%", "13%"],
				body,
			},
			layout: TABLE_LAYOUT,
			margin: [0, 0, 0, SECTION_GAP],
		},
	];
}

// ── header / footer ─────────────────────────────────────────────────────
// Explicit `: Content` return types are load-bearing — without them TS
// widens `margin` tuples to `number[]`, which pdfmake's Margins type rejects.

// Column-level `width` isn't on every Content variant in @types/pdfmake
// (ContentStack has none), so header columns use this local type.
type HeaderColumn = Content & { width?: number | string };

// Logo on the left (falls back to the company name if no logo is set),
// centred document title, empty right column to keep the title centred.
function buildLetterheadHeader(title: string): Content {
	const leftColumn: HeaderColumn = LOGO_DATA_URI
		? {
				width: HEADER_SIDE_WIDTH,
				stack: [
					{
						image: "logo",
						fit: [60, 28], // renders about 61×28pt
						alignment: "left" as const,
					},
				],
			}
		: {
				width: HEADER_SIDE_WIDTH,
				stack: [
					{
						text: "Tata Hitachi Construction Machinery",
						style: "letterheadCompany",
					},
				],
			};

	const columns: HeaderColumn[] = [
		leftColumn,
		{
			width: "*",
			stack: [
				{
					text: title,
					style: "letterheadTitle",
					alignment: "center" as const,
				},
			],
		},
		{ width: HEADER_SIDE_WIDTH, stack: [] },
	];

	return {
		margin: [HEADER_MARGIN_LEFT, HEADER_MARGIN_TOP, HEADER_MARGIN_RIGHT, 0],
		columns,
	};
}

// `statusLabel` is printed as-is (after formatStatusLabel) — callers decide
// what it says.
function buildStatusFooter(
	statusLabel: string,
	generatedOn: string,
): (currentPage: number, pageCount: number) => Content {
	const formattedStatus = formatStatusLabel(statusLabel);

	return (currentPage: number, pageCount: number): Content => ({
		margin: [FOOTER_MARGIN_LEFT, 0, FOOTER_MARGIN_RIGHT, FOOTER_MARGIN_BOTTOM],
		columns: [
			{ text: `Status: ${formattedStatus}`, style: "footerText" },
			{
				text: `Generated on ${generatedOn}  |  Page ${currentPage} of ${pageCount}`,
				alignment: "right" as const,
				style: "footerText",
			},
		],
	});
}

function baseDocDefinition(): Pick<
	TDocumentDefinitions,
	"pageSize" | "pageMargins" | "styles" | "defaultStyle" | "images"
> {
	return {
		pageSize: "A4",
		pageMargins: [
			PAGE_MARGIN_LEFT,
			PAGE_MARGIN_TOP,
			PAGE_MARGIN_RIGHT,
			PAGE_MARGIN_BOTTOM,
		],
		styles: STYLES,
		defaultStyle: DEFAULT_STYLE,
		...(LOGO_DATA_URI ? { images: { logo: LOGO_DATA_URI } } : {}),
	};
}

// ── public builder ──────────────────────────────────────────────────────

export function buildMedicalClaimDocDefinition(
	data: MedicalClaimPdfData,
): TDocumentDefinitions {
	return {
		...baseDocDefinition(),
		header: buildLetterheadHeader(DOCUMENT_TITLE),
		footer: buildStatusFooter(
			data.status,
			formatDateTimeSlash(data.generatedAt),
		),
		content: [
			...buildClaimDetailsSection(data),
			...buildAmountsSection(data),
			...buildBillsSection(data),
		],
	};
}

import type {
	TDocumentDefinitions,
	Content,
	TableCell,
	StyleDictionary,
	Style,
} from "pdfmake/interfaces";
import { VendorOnboardingPdfData } from "./vendorOnboardingAssembler";
import {
	displayValue,
	displayBoolean,
	displayDate,
	formatDateTimeSlash,
	displayDateTime,
	displayPendingOn,
} from "@pdf/pdfFieldFormatter";

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ONBOARDING — DOC DEFINITION BUILDERS
//

// Base64 data URI of the company logo, e.g. "data:image/png;base64,iVBOR...".
// Leave empty to fall back to the company name text in the header.
const LOGO_DATA_URI = "";

const DOCUMENT_TITLE = "Vendor Onboarding Form";

const BLACK = "#000000";
const GREY_TEXT = "#555555"; // footer only

// ── spacing & layout constants — tweak these to adjust the PDF ──────────
// All values are in pdfmake points (pt).

// Table cell padding (applies to every table in the document).
const CELL_PADDING_LEFT = 8;
const CELL_PADDING_RIGHT = 8;
const CELL_PADDING_TOP = 6;
const CELL_PADDING_BOTTOM = 6;

// Table border thickness.
const TABLE_LINE_WIDTH = 0.5;

// Vertical gap between one table and the next.
const SECTION_GAP = 10;

// Page margins: left, top, right, bottom. The top margin must leave room
// for the header; the bottom margin must leave room for the footer.
const PAGE_MARGIN_LEFT = 30;
const PAGE_MARGIN_TOP = 38;
const PAGE_MARGIN_RIGHT = 30;
const PAGE_MARGIN_BOTTOM = 40;

// Header block position (left/right should normally match the page margins).
const HEADER_MARGIN_LEFT = 30;
const HEADER_MARGIN_TOP = 12;
const HEADER_MARGIN_RIGHT = 30;

// Footer block position (left/right should normally match the page margins).
const FOOTER_MARGIN_LEFT = 30;
const FOOTER_MARGIN_RIGHT = 30;
const FOOTER_MARGIN_BOTTOM = 14;

// Space above the company name and the title inside the header.
const HEADER_COMPANY_MARGIN_TOP = 5;
const HEADER_TITLE_MARGIN_TOP = 3;

// Both side columns share one fixed width so the title column stays
// centred on the page whether or not a logo is present.
const HEADER_SIDE_WIDTH = 150;

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
		fontSize: 16,
		bold: true,
		color: BLACK,
		margin: [0, HEADER_TITLE_MARGIN_TOP, 0, 0],
	},
	footerText: { fontSize: 8, color: GREY_TEXT },
};

const DEFAULT_STYLE: Style = {
	font: "Helvetica",
	fontSize: 9.5,
	lineHeight: 1.3,
	color: BLACK,
};

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

function headCell(text: string): TableCell {
	return { text, bold: true };
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

// ── shared section builders ─────────────────────────────────────────────
// Both doc definitions render Vendor Details, Bank Details and Attached
// Documents identically — built once so the two PDFs can't drift apart.

function buildVendorDetailsSection(data: VendorOnboardingPdfData): Content[] {
	const v = data.vendor;
	const address =
		displayValue(v.address) +
		(v.city ? `, ${v.city}` : "") +
		(v.state ? `, ${v.state}` : "") +
		(v.pinCode ? ` - ${v.pinCode}` : "");

	return [
		buildFieldTable("Vendor Details", [
			field("Vendor Name", displayValue(v.vendorName), true),
			field("Address", address, true),
			field("Mobile", displayValue(v.mobile)),
			field("Email", displayValue(v.email)),
			field("GSTIN", displayValue(v.gstin)),
			field("PAN", displayValue(v.pan)),
			field("Entity Reg. No.", displayValue(v.entityRegNo)),
			field("Submitted On", formatDateTimeSlash(v.vendorSubmittedAt)),
			field("MSME Vendor", displayBoolean(v.msmeVendor)),
			field("NDA Obtained", displayBoolean(v.ndaObtained)),
		]),
	];
}

function buildBankDetailsSection(data: VendorOnboardingPdfData): Content[] {
	const b = data.bank;
	return [
		buildFieldTable("Bank Details", [
			field("Bank Name", displayValue(b.bankName)),
			field("IFSC Code", displayValue(b.ifscCode)),
			field("Branch", displayValue(b.bankBranch)),
			field("Account No.", displayValue(b.accountNumber)),
			field("Bank Address", displayValue(b.bankAddress), true),
		]),
	];
}

// NDA Obtained lives in Vendor Details only — not repeated here.
function buildProcurementDetailsSection(
	data: VendorOnboardingPdfData,
): Content[] {
	const p = data.procurement;
	return [
		buildFieldTable("Procurement Details", [
			field("Vendor Code", displayValue(p.vendorCode)),
			field("Vendor Type", displayValue(p.vendorType)),
			field("Company Code", displayValue(p.companyCode)),
			field("Purchase Org", displayValue(p.purchaseOrg)),
			field("Payment Term", displayValue(p.paymentTerm)),
			field("TDS", displayValue(p.tds)),
			field("Vendor Category", displayValue(p.vendorCategory)),
			field("Material Type", displayValue(p.materialType)),
			field("Material Sub Type", displayValue(p.materialSubType)),
			field("Nature of Service", displayValue(p.natureOfService)),
			field("Onboarding Reason", displayValue(p.onboardingReason)),
			field("Self-Assessment", displayBoolean(p.selfAssessmentObtained)),
			field("GPA Obtained", displayBoolean(p.gpaObtained)),
			field("Related Party", displayBoolean(p.isRelatedParty)),
			field("Vendor Audit Report", displayBoolean(p.vendorAuditReportPrepared)),
		]),
	];
}

// "Uploaded On" uses displayDateTime (date + seconds) — the exact
// submission time is the point of stamping it here.
function buildDocumentsSection(data: VendorOnboardingPdfData): Content[] {
	const body: TableCell[][] = [sectionBar("Attached Documents", 2)];

	if (data.documents.length > 0) {
		body.push([headCell("Document Type"), headCell("Uploaded On")]);
		data.documents.forEach((doc) =>
			body.push([
				{ text: doc.documentType },
				{ text: displayDateTime(doc.uploadedAt) },
			]),
		);
	} else {
		body.push([
			{ text: "No documents attached.", italics: true, colSpan: 2 },
			{ text: "" },
		]);
	}

	return [
		{
			table: {
				headerRows: 1,
				dontBreakRows: true,
				widths: ["50%", "50%"],
				body,
			},
			layout: TABLE_LAYOUT,
			margin: [0, 0, 0, SECTION_GAP],
		},
	];
}

// S.No | Person Name | Type | Status | Timestamp
function buildWorkflowSection(data: VendorOnboardingPdfData): Content[] {
	const COLS = 5;
	const body: TableCell[][] = [sectionBar("Workflow", COLS)];
	const stages = data.workflow?.stages ?? [];

	if (stages.length === 0) {
		body.push([
			{
				text: "No approval workflow has been initiated for this request yet.",
				italics: true,
				colSpan: COLS,
			},
			...filler(COLS - 1),
		]);
	} else {
		body.push([
			headCell("S.No"),
			headCell("Person Name"),
			headCell("Type"),
			headCell("Status"),
			headCell("Timestamp"),
		]);

		let serial = 0;
		stages.forEach((stage) => {
			const stageLabel = stage.stageName || `Stage ${stage.stageOrder}`;

			if (stage.approvals.length === 0) {
				serial += 1;
				body.push([
					{ text: String(serial) },
					{ text: "No approvers assigned", italics: true },
					{ text: stageLabel },
					{ text: "—" },
					{ text: "—" },
				]);
				return;
			}

			stage.approvals.forEach((approval) => {
				serial += 1;
				body.push([
					{ text: String(serial) },
					{ text: displayValue(approval.approverName) },
					{ text: stageLabel },
					{ text: displayValue(approval.status) },
					{ text: displayDateTime(approval.actedAt) },
				]);
			});
		});
	}

	return [
		{
			table: {
				headerRows: stages.length > 0 ? 2 : 1,
				dontBreakRows: true,
				widths: ["6%", "26%", "26%", "16%", "26%"],
				body,
			},
			layout: TABLE_LAYOUT,
			margin: [0, 0, 0, SECTION_GAP],
		},
	];
}

// Friendly labels for the ActivityAction values that can appear against a
// VENDOR_ONBOARDING subject. Anything not in this map falls back to the raw
// enum value rather than silently dropping the row.
const ACTIVITY_ACTION_LABELS: Record<string, string> = {
	VENDOR_ONBOARDING_INITIATED: "Initiated",
	VENDOR_FORM_SUBMITTED: "Submitted",
	VENDOR_ONBOARDING_SENT_FOR_APPROVAL: "Sent for Approval",
	VENDOR_ONBOARDING_CLOSED: "Completed",
	APPROVED: "Approved",
	REJECTED: "Rejected",
	CLARIFY: "Clarification Requested",
};

function displayActivityAction(action: string): string {
	return ACTIVITY_ACTION_LABELS[action] ?? action;
}

// S.No | Performed By | Action | Time | Comment
function buildAuditTrailSection(data: VendorOnboardingPdfData): Content[] {
	const COLS = 5;
	const body: TableCell[][] = [sectionBar("Audit Trail", COLS)];

	if (data.auditTrail.length > 0) {
		body.push([
			headCell("S.No"),
			headCell("Performed By"),
			headCell("Action"),
			headCell("Time"),
			headCell("Comment"),
		]);
		data.auditTrail.forEach((entry, index) =>
			body.push([
				{ text: String(index + 1) },
				{ text: displayValue(entry.performedBy) },
				{ text: displayActivityAction(entry.action) },
				{ text: displayDateTime(entry.createdAt) },
				{ text: displayValue(entry.reason) },
			]),
		);
	} else {
		body.push([
			{ text: "No activity recorded yet.", italics: true, colSpan: COLS },
			...filler(COLS - 1),
		]);
	}

	return [
		{
			table: {
				headerRows: data.auditTrail.length > 0 ? 2 : 1,
				dontBreakRows: true,
				widths: ["6%", "17%", "17%", "20%", "40%"],
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
						fit: [100, 34],
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

// `statusLabel` is printed as-is — callers decide what it says. The
// internal copy passes the dynamic "pending on" label; the vendor copy
// keeps passing the raw status enum.
function buildStatusFooter(
	statusLabel: string,
	generatedOn: string,
): (currentPage: number, pageCount: number) => Content {
	return (currentPage: number, pageCount: number): Content => ({
		margin: [FOOTER_MARGIN_LEFT, 0, FOOTER_MARGIN_RIGHT, FOOTER_MARGIN_BOTTOM],
		columns: [
			{ text: `Status: ${statusLabel}`, style: "footerText" },
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

// ── internal / employee copy — everything ─────────────────────────────────

export function buildVendorOnboardingDocDefinition(
	data: VendorOnboardingPdfData,
): TDocumentDefinitions {
	return {
		...baseDocDefinition(),
		header: buildLetterheadHeader(DOCUMENT_TITLE),
		// Dynamic status — the same computePendingOn result the listing/detail
		// endpoints already use (assembled in vendorOnboardingAssembler.ts).
		footer: buildStatusFooter(
			displayPendingOn(data.pendingOn),
			displayDate(data.generatedAt),
		),
		content: [
			...buildVendorDetailsSection(data),
			...buildBankDetailsSection(data),
			...buildProcurementDetailsSection(data),
			...buildDocumentsSection(data),
			...buildWorkflowSection(data),
			...buildAuditTrailSection(data),
		],
	};
}

// ── vendor-facing copy — vendor-submitted fields only ─────────────────────
// No Procurement Details, Workflow, or Audit Trail. Status footer stays the
// raw enum, not the approver-naming dynamic label.

export function buildVendorOnboardingVendorCopyDocDefinition(
	data: VendorOnboardingPdfData,
): TDocumentDefinitions {
	return {
		...baseDocDefinition(),
		header: buildLetterheadHeader(DOCUMENT_TITLE),
		footer: buildStatusFooter(data.status, displayDate(data.generatedAt)),
		content: [
			...buildVendorDetailsSection(data),
			...buildBankDetailsSection(data),
			...buildDocumentsSection(data),
		],
	};
}

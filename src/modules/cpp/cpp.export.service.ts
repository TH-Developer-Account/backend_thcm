// cpp.export.service.ts — everything a CPP request hands to other systems and people:
// the two SAP text files, the Excel export, the PDF as a Buffer, and the public view link.
// (cpp.export.controller.ts without Express, plus cpp.pdf.ts, merged in here.)
//
//   Excel          the summary table only, same layout as the blank template (cpp.sheet.ts)
//   ZINFOUPDATE_ME11  new price, WITH tax code   (SAP ME11 upload)
//   ZCHANGEINFO       price change, NO tax code
//   PDF            the form, summary sheet, approval workflow and audit trail
//
// Part rows come from the summary sheet (part info) the proposer uploaded. They are parsed
// at upload and stored on the "partSummary" attachment. Nothing here sends a response: the
// controller sets the headers, and cpp.mail.ts attaches the same files to the approved mail.
import type { TDocumentDefinitions } from "pdfmake/interfaces";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";
import { getOrGeneratePdfUrl } from "@pdf/pdf.services";

import {
	CPP_MAX_PARSE_BYTES,
	CPP_SUBJECT_TYPE,
	plantCodeOf,
	purchaseOrgForPlant,
} from "./cpp.constants";
import {
	masterPlantsOf,
	recommendedSupplierOf,
	safeFileName,
	sapReferenceOf,
} from "./cpp.helper";
import {
	type CppPirHeader,
	type PartSummaryRow,
	buildPartSummaryBuffer,
	parseCppPartRows,
	readStoredPartSummary,
} from "./cpp.sheet";
import { assembleCppPdfData, type CppPdfData } from "./cppAssembler";
import { buildCppDocDefinition } from "./cppDocDefinition";

/* ============================== SAP text files ============================== */

/* ── EDIT HERE: text-file settings ────────────────────────────────────────── */
const DELIMITER = "\t"; // "|" or "," if the target system needs it
/** Off: the part table is written without its column header line. */
const INCLUDE_HEADER_ROW = false;
/** Printed in the blank column: 31.12.9999 with the dots removed. */
const SAP_OPEN_END = "31129999";
/* ───────────────────────────────────────────────────────────────────────────── */

/** One part row as the text files need it. */
type TextRow = {
	partNo: string;
	/** SAP plant code, e.g. "3006". */
	plant: string;
	price: number | null;
	validFrom: string;
};

type TextContext = {
	row: TextRow;
	vendorCode: string;
	reference: string;
	/** Purchasing group and tax code from the request's Master Data tab. */
	master: { purchasingGroup: string; taxCode: string };
};

type TextColumn = { header: string; value: (c: TextContext) => string };
type TextFile = { fileName: string; columns: TextColumn[] };

/** 01.04.2026 -> 01042026 (dots and spaces removed). */
const sapDate = (value: string): string => value.replace(/[.\s]/g, "");

/** Whole numbers print without decimals, as SAP expects in the sample files. */
const priceText = (n: number | null): string =>
	n === null ? "" : Number.isInteger(n) ? String(n) : n.toFixed(2);

/* ── EDIT HERE: columns of each text file, in order ──────────────────────────
 * header = text on the first line ("" = blank header), value = what each row prints.
 * The purchasing organisation follows the plant (P506 for 8400, else P501). */
const ME11_COLUMNS: TextColumn[] = [
	{ header: "Vendor Code", value: (c) => c.vendorCode },
	{ header: "Part No", value: (c) => c.row.partNo },
	{ header: "PurchaseOrgOptions", value: (c) => purchaseOrgForPlant(c.row.plant) },
	{ header: "Plant", value: (c) => c.row.plant },
	{ header: "Purchasing group", value: (c) => c.master.purchasingGroup },
	{ header: "Tax Code", value: (c) => c.master.taxCode },
	{ header: "Price", value: (c) => priceText(c.row.price) },
	{ header: "WEFrom", value: (c) => sapDate(c.row.validFrom) },
	{ header: "", value: () => SAP_OPEN_END },
	{ header: "CPP Reference No", value: (c) => c.reference },
];

/** Same as ME11 without the Tax Code column. */
const CHANGEINFO_COLUMNS = ME11_COLUMNS.filter((c) => c.header !== "Tax Code");
/* ───────────────────────────────────────────────────────────────────────────── */

const TEXT_FILES = {
	me11: { fileName: "ZINFOUPDATE_ME11", columns: ME11_COLUMNS },
	changeinfo: { fileName: "ZCHANGEINFO", columns: CHANGEINFO_COLUMNS },
} satisfies Record<string, TextFile>;

export type CppTextKind = keyof typeof TEXT_FILES;

export const parseCppTextKind = (value: unknown): CppTextKind => {
	const key = String(value ?? "me11").toLowerCase();
	if (key !== "me11" && key !== "changeinfo")
		throw new ApiError(400, "file must be me11 or changeinfo");
	return key;
};

/** Tabs, line breaks and the delimiter would break the columns. */
const clean = (v: string) => v.replace(/[\t\r\n|]+/g, " ").trim();

/* ------------------------------- loading ------------------------------- */

type LoadedRequest = {
	reference: string;
	sections: unknown;
	/** Header of the purchasing Excel, when it could be read. */
	pirHeader: CppPirHeader | null;
	rows: PartSummaryRow[];
};

/**
 * `workspaceId` is given for a logged-in user (the request must be in their workspace) and
 * left out for the public view link, where the token already names the request.
 */
const loadRequest = async (
	id: string,
	workspaceId?: string,
): Promise<LoadedRequest> => {
	const request = await prisma.cppRequest.findUnique({
		where: { id },
		select: {
			workspaceId: true,
			referenceNumber: true,
			sections: true,
			attachments: {
				where: { type: { in: ["partSummary", "purchasingFile"] } },
				select: { type: true, s3Key: true, parsedData: true },
			},
		},
	});
	if (!request || (workspaceId && request.workspaceId !== workspaceId))
		throw new ApiError(404, "CPP request not found");

	const summary = request.attachments.find((a) => a.type === "partSummary");
	const rows = readStoredPartSummary(summary?.parsedData);
	if (rows.length === 0)
		throw new ApiError(
			422,
			"No summary sheet (part info) with part rows has been uploaded for this request.",
		);

	// The purchasing Excel is only needed for the supplier code on the text files.
	// If it cannot be read, the recommended supplier from the request is used.
	let pirHeader: CppPirHeader | null = null;
	const purchasing = request.attachments.find((a) => a.type === "purchasingFile");
	if (purchasing) {
		try {
			const buffer = await downloadFromS3(purchasing.s3Key);
			if (buffer && buffer.length <= CPP_MAX_PARSE_BYTES)
				pirHeader = parseCppPartRows(buffer).pirHeader;
		} catch {
			pirHeader = null;
		}
	}

	return {
		reference: request.referenceNumber,
		sections: request.sections,
		pirHeader,
		rows,
	};
};

/* ------------------------------- building ------------------------------ */

const buildTextFile = (file: TextFile, data: LoadedRequest): string => {
	const plants = masterPlantsOf(data.sections);
	const vendorCode =
		data.pirHeader?.supplierCode || recommendedSupplierOf(data.sections).code;
	const reference = sapReferenceOf(data.reference);

	const missing = new Set<string>();
	const contexts: TextContext[] = [];
	for (const r of data.rows) {
		const rawPlant = String(r.plant ?? "");
		const code = plantCodeOf(rawPlant);
		const master = code ? plants.find((p) => p.code === code) : undefined;
		if (!code || !master || !master.purchasingGroup || !master.taxCode) {
			missing.add(rawPlant || "(blank)");
			continue;
		}
		contexts.push({
			row: {
				partNo: String(r.partNo ?? ""),
				plant: code,
				price: typeof r.newPrice === "number" ? r.newPrice : null,
				validFrom: String(r.effectiveDate ?? ""),
			},
			vendorCode,
			reference,
			master,
		});
	}
	if (missing.size > 0)
		throw new ApiError(
			422,
			`Purchasing group or tax code is missing in Master Data for plant ${[...missing].join(", ")}. Fix it in the Master Data tab, or the request will be blocked at submit.`,
		);

	const lines: string[] = [];
	if (INCLUDE_HEADER_ROW)
		lines.push(file.columns.map((c) => c.header).join(DELIMITER));
	for (const ctx of contexts)
		lines.push(file.columns.map((c) => clean(c.value(ctx))).join(DELIMITER));
	return lines.join("\r\n") + "\r\n";
};

export type CppTextFile = { fileName: string; content: string };

const textFileOf = (kind: CppTextKind, data: LoadedRequest): CppTextFile => {
	const file: TextFile = TEXT_FILES[kind];
	return {
		fileName: `${file.fileName}-${safeFileName(data.reference)}.txt`,
		content: buildTextFile(file, data),
	};
};

/** One SAP text file. `workspaceId` is left out for the public link. */
export const exportCppText = async (
	id: string,
	kind: CppTextKind,
	workspaceId?: string,
): Promise<CppTextFile> => textFileOf(kind, await loadRequest(id, workspaceId));

/** Both SAP text files, for the approved mail to TCS. Throws like the export does. */
export const buildCppTextAttachments = async (id: string): Promise<CppTextFile[]> => {
	const data = await loadRequest(id);
	return (Object.keys(TEXT_FILES) as CppTextKind[]).map((kind) =>
		textFileOf(kind, data),
	);
};

/** The summary table only, locked: same layout as the blank template (see cpp.sheet.ts). */
export const exportCppExcel = async (
	id: string,
	workspaceId: string,
): Promise<{ fileName: string; buffer: Buffer }> => {
	const { reference, rows } = await loadRequest(id, workspaceId);
	return {
		fileName: `${safeFileName(reference)}.xlsx`,
		buffer: await buildPartSummaryBuffer(rows),
	};
};

/* ===================================== PDF ==================================== */
// Same document as GET /pdf/CPP_REQUEST/:id/url (cppAssembler + cppDocDefinition). The uploaded
// annexures are not merged here; they stay attachments of the request. If the shared PDF
// service exposes a "render to buffer" function, call it in renderCppPdf instead, so both
// paths use one renderer.

/** The PDF's built-in fonts (cppDocDefinition prints in Helvetica). */
const PDF_FONTS = {
	Helvetica: {
		normal: "Helvetica",
		bold: "Helvetica-Bold",
		italics: "Helvetica-Oblique",
		bolditalics: "Helvetica-BoldOblique",
	},
};

type PdfKitDoc = NodeJS.ReadableStream & { end: () => void };
type Printer020 = new (fonts: typeof PDF_FONTS) => {
	createPdfKitDocument: (def: TDocumentDefinitions) => PdfKitDoc;
};
type Pdfmake03 = {
	setFonts: (fonts: typeof PDF_FONTS) => void;
	createPdf: (def: TDocumentDefinitions) => { getBuffer: () => Promise<Buffer> };
};

/** Works with pdfmake 0.2.x (PdfPrinter class) and 0.3.x (setFonts / createPdf). */
const pdfToBuffer = async (def: TDocumentDefinitions): Promise<Buffer> => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const pdfmake = require("pdfmake") as Printer020 | Pdfmake03;

	if (typeof pdfmake === "function") {
		const doc = new pdfmake(PDF_FONTS).createPdfKitDocument(def);
		return new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			doc.on("data", (chunk: Buffer) => chunks.push(chunk));
			doc.on("end", () => resolve(Buffer.concat(chunks)));
			doc.on("error", reject);
			doc.end();
		});
	}
	pdfmake.setFonts(PDF_FONTS);
	return Buffer.from(await pdfmake.createPdf(def).getBuffer());
};

export const renderCppPdf = async (
	requestId: string,
): Promise<{ buffer: Buffer; data: CppPdfData }> => {
	const data = await assembleCppPdfData(requestId);
	return { buffer: await pdfToBuffer(buildCppDocDefinition(data)), data };
};

/* ============================ public view link ============================= */
// The approved mail carries a link with a VIEW_PDF token (issueAccessToken). The token is never
// marked used, so the TCS team opens the PDF and the text files without a login.

/** The request a view token belongs to, or 404 when the link is not valid. */
export const requestIdForViewToken = async (token: string): Promise<string> => {
	const record = await prisma.accessToken.findUnique({ where: { token } });
	if (
		!record ||
		record.subjectType !== CPP_SUBJECT_TYPE ||
		record.purpose !== "VIEW_PDF"
	)
		throw new ApiError(404, "Invalid or expired link");
	return record.subjectId;
};

/** A (cached) download URL of the request's PDF, for the public link to redirect to. */
export const pdfUrlForViewToken = async (token: string): Promise<string> =>
	getOrGeneratePdfUrl(CPP_SUBJECT_TYPE, await requestIdForViewToken(token));

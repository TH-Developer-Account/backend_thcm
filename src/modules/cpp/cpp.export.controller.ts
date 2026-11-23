// cpp.export.controller.ts — Excel export and the two SAP text files of a CPP request.
// Part rows come from the summary sheet (part info) the proposer uploaded; the parsed rows
// are stored on the "partSummary" attachment at upload (see cpp.partSummary.ts).
//
//   GET /cpp/:id/export/excel                  -> .xlsx, summary table only
//   GET /cpp/:id/export/text                   -> ZINFOUPDATE_ME11 (default)
//   GET /cpp/:id/export/text?file=me11         -> ZINFOUPDATE_ME11
//   GET /cpp/:id/export/text?file=changeinfo   -> ZCHANGEINFO
//
// The PDF goes through the shared  GET /pdf/CPP_REQUEST/:id/url  endpoint and is unchanged.
// Plant names -> SAP codes live in cpp.plants.ts (shared with the submit check).
import type { Request, Response } from "express";
import * as XLSX from "xlsx";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";

import {
	PART_SUMMARY_COLUMNS,
	type PartSummaryData,
	type PartSummaryRow,
} from "@modules/cpp/cpp.partSummary";
import { plantCodeOf } from "@modules/cpp/cpp.plants";
import { parseCppPartRows, type CppPirHeader } from "@modules/cpp/cppPartRows";

const MAX_BYTES = 8 * 1024 * 1024;

/* ── EDIT HERE: text-file settings ────────────────────────────────────────── */
const DELIMITER = "\t"; // "|" or "," if the target system needs it
/** Off: the part table is written without its column header line. */
const INCLUDE_HEADER_ROW = false;
/** SAP purchasing organisation, the same on every row. */
const PURCHASE_ORG = "P501";
/** Printed in the blank column: 31.12.9999 with the dots removed. */
const SAP_OPEN_END = "31129999";
/* ───────────────────────────────────────────────────────────────────────────── */

/* Master data for one SAP plant code (from the request's Master Data tab). */
type PlantMaster = { code: string; purchasingGroup: string; taxCode: string };

/** One part row as the text files need it. */
type TextRow = {
	partNo: string;
	plant: string;
	price: number | null;
	validFrom: string;
};

type LoadedRows = {
	reference: string;
	sections: unknown;
	pirHeader: CppPirHeader | null;
	summary: PartSummaryData;
};

type TextContext = {
	row: TextRow;
	vendorCode: string;
	reference: string;
	plant: PlantMaster;
};

type TextColumn = { header: string; value: (c: TextContext) => string };

type TextFile = { fileName: string; columns: TextColumn[] };

/* ── EDIT HERE: columns of each text file, in order ──────────────────────────
 * header = text on the first line ("" = blank header), value = what each row prints. */
const ZINFOUPDATE_ME11: TextColumn[] = [
	{ header: "Vendor Code", value: (c) => c.vendorCode },
	{ header: "Part No", value: (c) => c.row.partNo },
	{ header: "PurchaseOrgOptions", value: () => PURCHASE_ORG },
	{ header: "Plant", value: (c) => c.row.plant },
	{ header: "Purchasing group", value: (c) => c.plant.purchasingGroup },
	{ header: "Tax Code", value: (c) => c.plant.taxCode },
	{ header: "Price", value: (c) => priceText(c.row.price) },
	{ header: "WEFrom", value: (c) => sapDate(c.row.validFrom) },
	{ header: "", value: () => SAP_OPEN_END },
	{ header: "CPP Reference No", value: (c) => c.reference },
];
/* ───────────────────────────────────────────────────────────────────────────── */

const ZCHANGEINFO: TextColumn[] = [
	{ header: "Vendor Code", value: (c) => c.vendorCode },
	{ header: "Part No", value: (c) => c.row.partNo },
	{ header: "PurchaseOrgOptions", value: () => PURCHASE_ORG },
	{ header: "Plant", value: (c) => c.row.plant },
	{ header: "Purchasing group", value: (c) => c.plant.purchasingGroup },
	{ header: "WEFrom", value: (c) => sapDate(c.row.validFrom) },
	{ header: "", value: () => SAP_OPEN_END },
	{ header: "Price", value: (c) => priceText(c.row.price) },
	{ header: "CPP Reference No", value: (c) => c.reference },
];

const TEXT_FILES: Record<string, TextFile> = {
	me11: { fileName: "ZINFOUPDATE_ME11", columns: ZINFOUPDATE_ME11 },
	changeinfo: { fileName: "ZCHANGEINFO", columns: ZCHANGEINFO },
};

/* ── helpers ──────────────────────────────────────────────────────────────── */

const clean = (v: string) => v.replace(/[\t\r\n|]+/g, " ").trim();

/** 01.04.2026 -> 01042026 (dots and spaces removed). */
const sapDate = (value: string): string => value.replace(/[.\s]/g, "");

/** Whole numbers print without decimals, as SAP expects in the sample files. */
const priceText = (n: number | null): string =>
	n === null ? "" : Number.isInteger(n) ? String(n) : n.toFixed(2);

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

const sectionData = (
	sections: unknown,
	key: string,
): Record<string, unknown> => {
	const list = Array.isArray(sections) ? sections : [];
	const found = list.find(
		(s) => (s as { key?: unknown } | null)?.key === key,
	) as { data?: unknown } | undefined;
	return found?.data && typeof found.data === "object"
		? (found.data as Record<string, unknown>)
		: {};
};

const plantMasterOf = (sections: unknown): PlantMaster[] => {
	const list = sectionData(sections, "master").plantDetails;
	if (!Array.isArray(list)) return [];
	return list.map((p) => {
		const r = (p ?? {}) as Record<string, unknown>;
		return {
			code: String(r.code ?? "").trim(),
			purchasingGroup: String(r.purchasingGroup ?? "").trim(),
			taxCode: String(r.taxCode ?? "").trim(),
		};
	});
};

const recommendedSupplierCode = (sections: unknown): string => {
	const suppliers = sectionData(sections, "purchasing").suppliers as
		| { recommended?: { code?: unknown } }
		| undefined;
	return String(suppliers?.recommended?.code ?? "").trim();
};

/* ── loading ──────────────────────────────────────────────────────────────── */

async function loadRows(id: string): Promise<LoadedRows> {
	const request = await prisma.cppRequest.findUnique({
		where: { id },
		select: {
			referenceNumber: true,
			sections: true,
			attachments: {
				where: { type: { in: ["partSummary", "purchasingFile"] } },
				select: { type: true, s3Key: true, parsedData: true },
			},
		},
	});
	if (!request) throw new ApiError(404, "CPP request not found");

	const summaryFile = request.attachments.find((a) => a.type === "partSummary");
	const summary = summaryFile?.parsedData as unknown as PartSummaryData | null;
	if (!summary || !Array.isArray(summary.rows) || summary.rows.length === 0) {
		throw new ApiError(
			422,
			"No summary sheet (part info) with part rows has been uploaded for this request.",
		);
	}

	// The purchasing Excel is only needed for the supplier code on the text files.
	// If it cannot be read, the recommended supplier from the request is used.
	let pirHeader: CppPirHeader | null = null;
	const purchasing = request.attachments.find(
		(a) => a.type === "purchasingFile",
	);
	if (purchasing) {
		try {
			const buffer = await downloadFromS3(purchasing.s3Key);
			if (buffer && buffer.length <= MAX_BYTES)
				pirHeader = parseCppPartRows(buffer).pirHeader;
		} catch {
			pirHeader = null;
		}
	}

	return {
		reference: request.referenceNumber,
		sections: request.sections,
		pirHeader,
		summary,
	};
}

/* ── text files ───────────────────────────────────────────────────────────── */

export const buildCppTextFile = (file: TextFile, data: LoadedRows): string => {
	const plants = plantMasterOf(data.sections);
	const vendorCode =
		data.pirHeader?.supplierCode || recommendedSupplierCode(data.sections);
	// The SAP reference is the number only: WS5792955058 -> 5792955058.
	const reference = data.reference.replace(/^WS/i, "");

	const missing = new Set<string>();
	const rows: TextContext[] = [];
	for (const r of data.summary.rows as PartSummaryRow[]) {
		const rawPlant = String(r.plant ?? "");
		const code = plantCodeOf(rawPlant);
		const plant = code ? plants.find((p) => p.code === code) : undefined;
		if (!code || !plant || !plant.purchasingGroup || !plant.taxCode) {
			missing.add(rawPlant || "(blank)");
			continue;
		}
		rows.push({
			row: {
				partNo: String(r.partNo ?? ""),
				plant: code,
				price: typeof r.newPrice === "number" ? r.newPrice : null,
				validFrom: String(r.effectiveDate ?? ""),
			},
			vendorCode,
			reference,
			plant,
		});
	}
	if (missing.size > 0) {
		throw new ApiError(
			422,
			`Purchasing group or tax code is missing in Master Data for plant ${[...missing].join(", ")}. Fix it in the Master Data tab, or the request will be blocked at submit.`,
		);
	}

	const lines: string[] = [];
	if (INCLUDE_HEADER_ROW)
		lines.push(file.columns.map((c) => c.header).join(DELIMITER));
	for (const ctx of rows)
		lines.push(file.columns.map((c) => clean(c.value(ctx))).join(DELIMITER));

	return lines.join("\r\n") + "\r\n";
};

export const exportCppText = async (req: Request, res: Response) => {
	const key = String(req.query.file ?? "me11").toLowerCase();
	const file = TEXT_FILES[key];
	if (!file) throw new ApiError(400, "file must be me11 or changeinfo");

	const data = await loadRows(String(req.params.id));
	const body = buildCppTextFile(file, data);

	res
		.status(200)
		.setHeader("Content-Type", "text/plain; charset=utf-8")
		.setHeader(
			"Content-Disposition",
			`attachment; filename="${file.fileName}-${safeName(data.reference)}.txt"`,
		)
		.send(body);
};

/* ── excel ────────────────────────────────────────────────────────────────── */

/** Summary table only: group row, sub-header row, then the part rows. */
const summaryTableSheet = (table: PartSummaryData): XLSX.WorkSheet => {
	const columns = PART_SUMMARY_COLUMNS;
	const groupRow = columns.map((c, i) =>
		i === 0 || columns[i - 1].group !== c.group ? c.group : "",
	);
	const headerRow = columns.map((c) => c.header);
	const dataRows = (table.rows as PartSummaryRow[]).map((r) =>
		columns.map((c) => r[c.key] ?? null),
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

	const ws = XLSX.utils.aoa_to_sheet([groupRow, headerRow, ...dataRows]);
	ws["!merges"] = merges;
	ws["!cols"] = columns.map(() => ({ wch: 16 }));
	return ws;
};

export const exportCppExcel = async (req: Request, res: Response) => {
	const { reference, summary } = await loadRows(String(req.params.id));

	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, summaryTableSheet(summary), "Summary");
	const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

	res
		.status(200)
		.setHeader(
			"Content-Type",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		)
		.setHeader(
			"Content-Disposition",
			`attachment; filename="${safeName(reference)}.xlsx"`,
		)
		.send(out);
};

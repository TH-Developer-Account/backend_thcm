// cpp.export.controller.ts — Excel export and the two SAP text files of a CPP
// request. Both are built from the Price Update rows in the purchasing Excel
// the proposer uploaded (attachment type "purchasingFile").
//
//   GET /cpp/:id/export/excel                  -> .xlsx ("Price Update" layout)
//   GET /cpp/:id/export/text                   -> ZINFOUPDATE_ME11 (default)
//   GET /cpp/:id/export/text?file=me11         -> ZINFOUPDATE_ME11
//   GET /cpp/:id/export/text?file=changeinfo   -> ZCHANGEINFO
//
// The PDF goes through the shared  GET /pdf/CPP_REQUEST/:id/url  endpoint.
import type { Request, Response } from "express";
import * as XLSX from "xlsx";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";

import {
	parseCppPartRows,
	type CppPirRow,
	type CppPirHeader,
} from "@modules/cpp/cppPartRows";

const MAX_BYTES = 8 * 1024 * 1024;

/* ── EDIT HERE: text-file settings ────────────────────────────────────────── */
const DELIMITER = "\t"; // "|" or "," if the target system needs it
const INCLUDE_HEADER_ROW = true;
/** SAP purchasing organisation, the same on every row. */
const PURCHASE_ORG = "P501";
/** Printed in the blank column: 31.12.9999 with the dots removed. */
const SAP_OPEN_END = "31129999";
/* ───────────────────────────────────────────────────────────────────────────── */

/* Master data for one SAP plant code (from the request's Master Data tab). */
type PlantMaster = { code: string; purchasingGroup: string; taxCode: string };

type LoadedRows = {
	reference: string;
	sections: unknown;
	pir: CppPirRow[];
	pirHeader: CppPirHeader | null;
};

type TextContext = {
	row: CppPirRow;
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
/* ─────────────────────────────────────────────────────────────────────────── */

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
				where: { type: "purchasingFile" },
				select: { s3Key: true, fileName: true },
			},
		},
	});
	if (!request) throw new ApiError(404, "CPP request not found");

	const file = request.attachments[0];
	if (!file) {
		throw new ApiError(
			422,
			"No Purchase Info Record Excel has been uploaded for this request.",
		);
	}

	const buffer = await downloadFromS3(file.s3Key);
	if (!buffer || buffer.length > MAX_BYTES) {
		throw new ApiError(422, "The uploaded Excel could not be read.");
	}

	const parsed = parseCppPartRows(buffer);
	if (parsed.pir.length === 0) {
		throw new ApiError(
			422,
			'No part rows were found. The Excel needs a "Price Update" sheet with the Part No / Price columns.',
		);
	}
	return {
		reference: request.referenceNumber,
		sections: request.sections,
		pir: parsed.pir,
		pirHeader: parsed.pirHeader,
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
	for (const row of data.pir) {
		const plant = plants.find((p) => p.code === row.plant);
		if (!plant || !plant.purchasingGroup || !plant.taxCode) {
			missing.add(row.plant || "(blank)");
			continue;
		}
		rows.push({ row, vendorCode, reference, plant });
	}
	if (missing.size > 0) {
		throw new ApiError(
			422,
			`Purchasing group or tax code is missing in Master Data for plant ${[...missing].join(", ")}.`,
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

export const exportCppExcel = async (req: Request, res: Response) => {
	const { reference, pir, pirHeader } = await loadRows(String(req.params.id));

	const aoa: (string | number | null)[][] = [
		["Purchase Info Record — Price Update"],
		["CPP Reference No", pirHeader?.referenceNo || reference],
		["Plant(s)", pirHeader?.plants ?? ""],
		["Supplier Code", pirHeader?.supplierCode ?? ""],
		["Special notes", pirHeader?.specialNotes ?? ""],
		[],
		[
			"Sr",
			"Part No",
			"Description",
			"WEFrom",
			"Upto",
			"Condition",
			"Price",
			"Needs Material Master Change?",
			"Plant",
			"PO for POSA",
		],
		...pir.map((r, i) => [
			r.sr ?? i + 1,
			r.partNo,
			r.description,
			r.validFrom,
			r.validTo,
			r.condition,
			r.price,
			r.needsMasterChange,
			r.plant,
			r.poForPosa,
		]),
	];

	const ws = XLSX.utils.aoa_to_sheet(aoa);
	ws["!cols"] = [6, 16, 34, 12, 12, 10, 12, 18, 8, 16].map((wch) => ({ wch }));
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Price Update");
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

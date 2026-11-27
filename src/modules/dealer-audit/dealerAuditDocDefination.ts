import type {
	Content,
	TableCell,
	TDocumentDefinitions,
} from "pdfmake/interfaces";
import { LOGO_DATA_URI } from "@vendor-onboarding/vendorOnboardingLogo";
import { DealerAuditPdfData } from "./dealerAuditAssembler";

// Layout follows the "Summary" sheet of the HO Audit format, followed by the
// parameter-wise detail.

const TITLE = "INFRA ASSESSMENT OF TATA HITACHI DEALERSHIP NETWORK";
const GREY = "#d9d9d9";

// Touchpoint strength bands from the Summary sheet.
const BANDS = [
	["< 60%", "Weak Touchpoint", "Need urgent review"],
	["60 - 80%", "Average Touchpoint", "Scope for improvement"],
	["> 80%", "Strong Touchpoint", "On Track"],
];
const bandIndex = (percent: number) =>
	percent < 60 ? 0 : percent <= 80 ? 1 : 2;

const BOXED = {
	hLineWidth: () => 0.5,
	vLineWidth: () => 0.5,
	paddingTop: () => 4,
	paddingBottom: () => 3,
};

const OFFICE_LABELS: Record<string, string> = {
	HEAD_OFFICE: "HO",
	BRANCH_OFFICE: "BO",
};

const formatDate = (date: Date | null) =>
	date
		? date.toLocaleDateString("en-GB", {
				day: "2-digit",
				month: "short",
				year: "numeric",
				timeZone: "Asia/Kolkata",
			})
		: "-";

const percentOf = (score: number, max: number) =>
	max > 0 ? `${Math.round((score / max) * 1000) / 10}%` : "-";

const head = (value: string): TableCell => ({
	text: value,
	bold: true,
	fillColor: GREY,
	alignment: "center",
});

const banner = (value: string): Content => ({
	table: { widths: ["*"], body: [[head(value)]] },
	layout: BOXED,
	margin: [0, 0, 0, 8],
});

export function buildDealerAuditDocDefinition(
	data: DealerAuditPdfData,
): TDocumentDefinitions {
	const logo: Content = LOGO_DATA_URI
		? { image: LOGO_DATA_URI, width: 150, alignment: "center" }
		: { text: "TATA HITACHI", bold: true, fontSize: 16, alignment: "center" };

	const info: [string, string][] = [
		["Dealership", data.dealerName],
		["Location", data.location || "-"],
		["Category", OFFICE_LABELS[data.officeType] ?? data.officeType],
		["Facility", data.facility || "-"],
		["Address", data.address || "-"],
	];

	const signatures = [
		"Dealership Manager",
		"Tata Hitachi Branch Official",
		"Tata Hitachi Assessor",
	];

	return {
		pageSize: "A4",
		pageMargins: [36, 32, 36, 36],
		content: [
			{ stack: [logo], margin: [0, 0, 0, 12] },
			banner(TITLE),
			{
				text: `Date of Assessment: ${formatDate(data.assessmentDate)}`,
				alignment: "right",
				bold: true,
				margin: [0, 0, 0, 6],
			},
			{
				table: {
					widths: [110, "*"],
					body: info.map(([label, value]) => [
						{ text: label, bold: true },
						{ text: value },
					]),
				},
				layout: BOXED,
				margin: [0, 0, 0, 14],
			},
			banner("ASSESSMENT SUMMARY"),
			{
				table: {
					headerRows: 1,
					widths: ["*", 80, 90, 110],
					body: [
						[
							head("Function"),
							head("Total Score"),
							head("Obtained Score"),
							head("Percentage Achievement"),
						],
						...data.functions.map((row) => [
							{ text: row.name },
							{ text: `${row.maxScore}`, alignment: "center" as const },
							{ text: `${row.score}`, alignment: "center" as const },
							{
								text: percentOf(row.score, row.maxScore),
								alignment: "center" as const,
							},
						]),
						[
							{ text: "Total", bold: true },
							{ text: `${data.maxScore}`, bold: true, alignment: "center" },
							{ text: `${data.totalScore}`, bold: true, alignment: "center" },
							{ text: `${data.percent}%`, bold: true, alignment: "center" },
						],
					],
				},
				layout: BOXED,
				margin: [0, 0, 0, 12],
			},
			banner(
				`Assessment Score of Touchpoint: ${data.percent}% - ${BANDS[bandIndex(data.percent)][1]}`,
			),
			{
				table: {
					widths: [90, "*", "*"],
					body: [
						[
							head("Score"),
							head("Network Strength"),
							head("Recommendation by Tata Hitachi"),
						],
						...BANDS.map((band, index) =>
							band.map((value) => ({
								text: value,
								alignment: "center" as const,
								bold: index === bandIndex(data.percent),
							})),
						),
					],
				},
				layout: BOXED,
				margin: [0, 0, 0, 48],
			},
			{
				columns: signatures.map((label) => ({
					text: `______________________\n${label}`,
					alignment: "center" as const,
				})),
				unbreakable: true,
			},
			{
				stack: [banner("PARAMETER-WISE DETAILS")],
				pageBreak: "before",
			},
			{
				text: `${data.templateName} | ${data.periodLabel}`,
				margin: [0, 0, 0, 6],
			},
			{
				table: {
					headerRows: 1,
					widths: [70, "*", 36, 44, 130],
					body: [
						[
							head("Function"),
							head("Check Point"),
							head("Dealer"),
							head("Reviewer"),
							head("Remarks"),
						],
						...data.items.map((item) => [
							{ text: item.sectionName },
							{ text: item.label },
							{
								text: item.dealerScore?.toString() ?? "-",
								alignment: "center" as const,
							},
							{
								text: item.reviewerScore?.toString() ?? "-",
								alignment: "center" as const,
							},
							{ text: item.reviewerRemark ?? "-" },
						]),
					],
				},
				layout: BOXED,
			},
		],
		footer: (page: number, pages: number) => ({
			text: `Page ${page} of ${pages}`,
			alignment: "center",
			fontSize: 7,
		}),
		// Only the built-in Helvetica family is registered with the renderer.
		defaultStyle: { font: "Helvetica", fontSize: 9 },
	};
}

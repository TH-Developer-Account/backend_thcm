import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import { MedicalClaimPdfData } from "./mediclaimAssembler";
import {
  displayValue,
  displayBoolean,
  displayDate,
} from "@pdf/pdfFieldFormatter";

// ─────────────────────────────────────────────────────────────────────────────
// MEDICAL CLAIM — DOC DEFINITION BUILDER
//
// Pure function: MedicalClaimPdfData in, pdfmake TDocumentDefinitions out.
// No I/O, no S3, no rendering — just layout. Mirrors
// vendorOnboardingDocDofination.ts, including its fieldRow/table helpers,
// so the two PDF types stay visually consistent.
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEADER_STYLE = "sectionHeader";
const LABEL_STYLE = "fieldLabel";

// A field row is [label, value] — kept as a small tuple builder so every
// section constructs its table rows the same way (DRY across sections).
function fieldRow(label: string, value: string): Content[] {
  return [{ text: label, style: LABEL_STYLE }, { text: value }];
}

function buildTwoColumnTable(rows: Content[][]): Content {
  return {
    table: {
      widths: ["35%", "65%"],
      body: rows,
    },
    layout: "lightHorizontalLines",
    margin: [0, 0, 0, 16],
  };
}

const displayAmount = (value: number | null): string =>
  value === null
    ? "—"
    : value.toLocaleString("en-IN", { style: "currency", currency: "INR" });

export function buildMedicalClaimDocDefinition(
  data: MedicalClaimPdfData,
): TDocumentDefinitions {
  const claimRows = [
    fieldRow("Employee Name", displayValue(data.claim.employeeName)),
    fieldRow("Ticket Number", displayValue(data.claim.ticketNumber)),
    fieldRow("Mobile", displayValue(data.claim.mobile)),
    fieldRow("Email", displayValue(data.claim.email)),
    fieldRow("Grade", displayValue(data.claim.grade)),
    fieldRow("Location", displayValue(data.claim.location)),
    fieldRow("Patient Name", displayValue(data.claim.patientName)),
    fieldRow("Claim Cover", displayValue(data.claim.claimCover)),
    fieldRow("Spouse Name", displayValue(data.claim.spouseName)),
    fieldRow(
      "Medical Advance Taken",
      displayAmount(data.claim.medicalAdvanceTaken),
    ),
    fieldRow("Submitted On", displayDate(data.claim.submittedAt)),
  ];

  const amountRows = [
    fieldRow("Eligible Amount", displayAmount(data.amounts.eligibleAmount)),
    fieldRow(
      "Already Settled (this year)",
      displayAmount(data.amounts.alreadySettled),
    ),
    fieldRow("Total Claimed", displayAmount(data.amounts.totalClaimed)),
  ];

  const billsTable: Content =
    data.bills.length > 0
      ? {
          table: {
            widths: ["20%", "15%", "20%", "15%", "15%", "15%"],
            body: [
              [
                { text: "Claim Head", style: LABEL_STYLE },
                { text: "Bill No.", style: LABEL_STYLE },
                { text: "Bill Name", style: LABEL_STYLE },
                { text: "Bill Date", style: LABEL_STYLE },
                { text: "Amount", style: LABEL_STYLE },
                { text: "Approved", style: LABEL_STYLE },
              ],
              ...data.bills.map((bill) => [
                { text: bill.claimHead },
                { text: displayValue(bill.billNo) },
                { text: displayValue(bill.billName) },
                { text: displayDate(bill.billDate) },
                {
                  text: displayAmount(bill.approvedClaimAmount ?? bill.amount),
                },
                { text: displayBoolean(bill.approved) },
              ]),
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 16],
        }
      : {
          text: "No claim bills attached.",
          italics: true,
          margin: [0, 0, 0, 16],
        };

  return {
    pageSize: "A4",
    pageMargins: [40, 100, 40, 60],

    header: {
      margin: [40, 20, 40, 0],
      columns: [
        {
          text: "Tata Hitachi Construction Machinery",
          style: "letterheadTitle",
        },
        {
          text: `Medical Claim — ${data.claim.referenceNumber}`,
          style: "letterheadSubtitle",
          alignment: "right",
        },
      ],
    },

    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 0, 40, 20],
      columns: [
        { text: `Status: ${data.status}`, style: "footerText" },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          alignment: "right",
          style: "footerText",
        },
      ],
    }),

    content: [
      { text: "Claim Details", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(claimRows),

      { text: "Amounts", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(amountRows),

      { text: "Claim Bills", style: SECTION_HEADER_STYLE },
      billsTable,

      {
        text: `Generated on ${displayDate(data.generatedAt)}`,
        style: "footerText",
        margin: [0, 8, 0, 0],
      },
    ],

    styles: {
      letterheadTitle: { fontSize: 14, bold: true },
      letterheadSubtitle: { fontSize: 10, color: "#555555" },
      sectionHeader: {
        fontSize: 12,
        bold: true,
        margin: [0, 12, 0, 6],
        color: "#1a1a1a",
      },
      fieldLabel: { bold: true, color: "#444444" },
      footerText: { fontSize: 8, color: "#888888" },
    },

    defaultStyle: {
      font: "Helvetica",
      fontSize: 10,
    },
  };
}

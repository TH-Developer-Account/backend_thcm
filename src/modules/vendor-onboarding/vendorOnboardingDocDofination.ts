import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import { VendorOnboardingPdfData } from "./vendorOnboardingAssembler";
import {
  displayValue,
  displayBoolean,
  displayDate,
} from "@pdf/pdfFieldFormatter";

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ONBOARDING — DOC DEFINITION BUILDER
//
// Pure function: VendorOnboardingPdfData in, pdfmake TDocumentDefinitions out.
// No I/O, no S3, no rendering — just layout. This is the pdfmake equivalent
// of an .hbs template, kept in TS since pdfmake has no external template file.
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

export function buildVendorOnboardingDocDefinition(
  data: VendorOnboardingPdfData,
): TDocumentDefinitions {
  const vendorRows = [
    fieldRow("Vendor Name", displayValue(data.vendor.vendorName)),
    fieldRow(
      "Address",
      displayValue(data.vendor.address) +
        (data.vendor.city ? `, ${data.vendor.city}` : "") +
        (data.vendor.state ? `, ${data.vendor.state}` : "") +
        (data.vendor.pinCode ? ` - ${data.vendor.pinCode}` : ""),
    ),
    fieldRow("Mobile", displayValue(data.vendor.mobile)),
    fieldRow("Email", displayValue(data.vendor.email)),
    fieldRow("GSTIN", displayValue(data.vendor.gstin)),
    fieldRow("PAN", displayValue(data.vendor.pan)),
    fieldRow("Entity Registration No.", displayValue(data.vendor.entityRegNo)),
    fieldRow("MSME Vendor", displayBoolean(data.vendor.msmeVendor)),
    fieldRow("Vendor Submitted On", displayDate(data.vendor.vendorSubmittedAt)),
  ];

  const bankRows = [
    fieldRow("Bank Name", displayValue(data.bank.bankName)),
    fieldRow("Branch", displayValue(data.bank.bankBranch)),
    fieldRow("IFSC Code", displayValue(data.bank.ifscCode)),
    fieldRow("Account Number", displayValue(data.bank.accountNumber)),
    fieldRow("Bank Address", displayValue(data.bank.bankAddress)),
  ];

  const procurementRows = [
    fieldRow("Vendor Code", displayValue(data.procurement.vendorCode)),
    fieldRow("Vendor Type", displayValue(data.procurement.vendorType)),
    fieldRow("Company Code", displayValue(data.procurement.companyCode)),
    fieldRow("Purchase Org", displayValue(data.procurement.purchaseOrg)),
    fieldRow("Payment Term", displayValue(data.procurement.paymentTerm)),
    fieldRow("TDS", displayValue(data.procurement.tds)),
    fieldRow("Vendor Category", displayValue(data.procurement.vendorCategory)),
    fieldRow("Material Type", displayValue(data.procurement.materialType)),
    fieldRow(
      "Material Sub Type",
      displayValue(data.procurement.materialSubType),
    ),
    fieldRow(
      "Nature of Service",
      displayValue(data.procurement.natureOfService),
    ),
    fieldRow(
      "Onboarding Reason",
      displayValue(data.procurement.onboardingReason),
    ),
    fieldRow(
      "Self-Assessment Obtained",
      displayBoolean(data.procurement.selfAssessmentObtained),
    ),
    fieldRow("NDA Obtained", displayBoolean(data.procurement.ndaObtained)),
    fieldRow("GPA Obtained", displayBoolean(data.procurement.gpaObtained)),
    fieldRow("Related Party", displayBoolean(data.procurement.isRelatedParty)),
    fieldRow(
      "Vendor Audit Report Prepared",
      displayBoolean(data.procurement.vendorAuditReportPrepared),
    ),
  ];

  const documentsTable: Content =
    data.documents.length > 0
      ? {
          table: {
            widths: ["60%", "40%"],
            body: [
              [
                { text: "Document Type", style: LABEL_STYLE },
                { text: "Uploaded On", style: LABEL_STYLE },
              ],
              ...data.documents.map((doc) => [
                { text: doc.documentType },
                { text: displayDate(doc.uploadedAt) },
              ]),
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 16],
        }
      : {
          text: "No documents attached.",
          italics: true,
          margin: [0, 0, 0, 16],
        };

  return {
    pageSize: "A4",
    pageMargins: [40, 100, 40, 60],

    // Letterhead — repeats on every page.
    header: {
      margin: [40, 20, 40, 0],
      columns: [
        {
          text: "Tata Hitachi Construction Machinery",
          style: "letterheadTitle",
        },
        {
          text: "Vendor Onboarding Record",
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
      { text: "Vendor Details", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(vendorRows),

      { text: "Bank Details", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(bankRows),

      { text: "Procurement Details", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(procurementRows),

      { text: "Attached Documents", style: SECTION_HEADER_STYLE },
      documentsTable,

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

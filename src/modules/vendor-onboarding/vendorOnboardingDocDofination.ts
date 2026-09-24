import type {
  TDocumentDefinitions,
  Content,
  StyleDictionary,
  Style,
} from "pdfmake/interfaces";
import { VendorOnboardingPdfData } from "./vendorOnboardingAssembler";
import {
  displayValue,
  displayBoolean,
  displayDate,
  displayDateTime,
  displayPendingOn,
} from "@pdf/pdfFieldFormatter";

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ONBOARDING — DOC DEFINITION BUILDERS
//
// Pure functions: VendorOnboardingPdfData in, pdfmake TDocumentDefinitions
// out. No I/O, no S3, no rendering — just layout. This is the pdfmake
// equivalent of an .hbs template, kept in TS since pdfmake has no external
// template file.
//
// Two builders live here, sharing the section helpers below:
//   - buildVendorOnboardingDocDefinition        → internal/employee copy,
//     everything including Procurement Details (employee-owned fields),
//     Workflow, and Audit Trail — plus a dynamic "pending on" status line.
//   - buildVendorOnboardingVendorCopyDocDefinition → vendor-facing copy,
//     only the fields the vendor themselves submitted (Vendor + Bank +
//     Documents) — served on the public, unauthenticated view link, so it
//     must never carry internal procurement data, approver identities, or
//     internal workflow/audit history.
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

// Explicitly typed as StyleDictionary/Style rather than `as const` — `as
// const` makes every nested array (including each style's `margin` tuple)
// readonly, and pdfmake's Margins type wants a mutable [number, number,
// number, number]. An explicit pdfmake type gives every literal its correct
// shape up front instead.
const STYLES: StyleDictionary = {
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
};

const DEFAULT_STYLE: Style = {
  font: "Helvetica",
  fontSize: 10,
};

// ── shared section builders ─────────────────────────────────────────────
// Both doc definitions below render the same Vendor Details, Bank Details
// and Attached Documents sections identically — built once here so the two
// PDFs can never silently drift apart on shared fields.

function buildVendorDetailsSection(data: VendorOnboardingPdfData): Content[] {
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

  return [
    { text: "Vendor Details", style: SECTION_HEADER_STYLE },
    buildTwoColumnTable(vendorRows),
  ];
}

function buildBankDetailsSection(data: VendorOnboardingPdfData): Content[] {
  const bankRows = [
    fieldRow("Bank Name", displayValue(data.bank.bankName)),
    fieldRow("Branch", displayValue(data.bank.bankBranch)),
    fieldRow("IFSC Code", displayValue(data.bank.ifscCode)),
    fieldRow("Account Number", displayValue(data.bank.accountNumber)),
    fieldRow("Bank Address", displayValue(data.bank.bankAddress)),
  ];

  return [
    { text: "Bank Details", style: SECTION_HEADER_STYLE },
    buildTwoColumnTable(bankRows),
  ];
}

function buildProcurementDetailsSection(
  data: VendorOnboardingPdfData,
): Content[] {
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

  return [
    { text: "Procurement Details", style: SECTION_HEADER_STYLE },
    buildTwoColumnTable(procurementRows),
  ];
}

// "Uploaded On" uses displayDateTime (date + seconds) rather than
// displayDate — these are the vendor's attached documents, and the exact
// submission time is the whole point of stamping it here.
function buildDocumentsSection(data: VendorOnboardingPdfData): Content[] {
  const documentsTable: Content =
    data.documents.length > 0
      ? {
          table: {
            widths: ["50%", "50%"],
            body: [
              [
                { text: "Document Type", style: LABEL_STYLE },
                { text: "Uploaded On", style: LABEL_STYLE },
              ],
              ...data.documents.map((doc) => [
                { text: doc.documentType },
                { text: displayDateTime(doc.uploadedAt) },
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

  return [
    { text: "Attached Documents", style: SECTION_HEADER_STYLE },
    documentsTable,
  ];
}

// ── internal-copy-only section builders ─────────────────────────────────
// Neither of these is called from buildVendorOnboardingVendorCopyDocDefinition
// — approver identities and the internal approval/activity history are not
// for the public, unauthenticated vendor-facing link.

// One stage heading + one approver table per stage, current iteration only
// (data.workflow is assembled from isCurrentIteration: true stages — see
// vendorOnboardingAssembler.ts). A stage with zero approvers still renders
// its heading with a "No approvers assigned" placeholder row, rather than
// silently disappearing from the section.
function buildWorkflowSection(data: VendorOnboardingPdfData): Content[] {
  if (!data.workflow || data.workflow.stages.length === 0) {
    return [
      { text: "Workflow", style: SECTION_HEADER_STYLE },
      {
        text: "No approval workflow has been initiated for this request yet.",
        italics: true,
        margin: [0, 0, 0, 16],
      },
    ];
  }

  const stageBlocks: Content[] = data.workflow.stages.flatMap(
    (stage): Content[] => {
      const approvalRows: Content[][] =
        stage.approvals.length > 0
          ? stage.approvals.map((approval) => [
              { text: approval.approverName },
              { text: displayValue(approval.status) },
              { text: displayDateTime(approval.actedAt) },
              { text: displayValue(approval.reason) },
            ])
          : [
              [
                { text: "No approvers assigned", italics: true },
                { text: "—" },
                { text: "—" },
                { text: "—" },
              ],
            ];

      return [
        {
          text:
            `Stage ${stage.stageOrder}` +
            (stage.stageName ? `: ${stage.stageName}` : "") +
            ` — ${displayValue(stage.strategy)} strategy — ${displayValue(stage.status)}`,
          bold: true,
          margin: [0, 8, 0, 4],
        },
        {
          table: {
            widths: ["30%", "18%", "27%", "25%"],
            body: [
              [
                { text: "Approver", style: LABEL_STYLE },
                { text: "Status", style: LABEL_STYLE },
                { text: "Acted On", style: LABEL_STYLE },
                { text: "Reason", style: LABEL_STYLE },
              ],
              ...approvalRows,
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 8],
        },
      ];
    },
  );

  return [{ text: "Workflow", style: SECTION_HEADER_STYLE }, ...stageBlocks];
}

// Friendly labels for the ActivityAction values that can appear against a
// VENDOR_ONBOARDING subject (see schema.prisma's ActivityAction enum and
// every tx.activityLog.create({ subjectType: "VENDOR_ONBOARDING", ... }) call
// across vendorOnboarding.controller.ts and workflow.controller.ts/service.ts:
// initiation, vendor submission, send-for-approval and closure are vendor-
// onboarding-specific; APPROVED/REJECTED/CLARIFY are the shared workflow
// actions every subject type logs the same way). Anything not in this map
// (e.g. a future action added elsewhere) falls back to the raw enum value
// rather than silently dropping the row.
const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  VENDOR_ONBOARDING_INITIATED: "Vendor Onboarding Initiated",
  VENDOR_FORM_SUBMITTED: "Vendor Form Submitted",
  VENDOR_ONBOARDING_SENT_FOR_APPROVAL: "Sent for Approval",
  VENDOR_ONBOARDING_CLOSED: "Vendor Onboarding Closed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CLARIFY: "Clarification Requested",
};

function displayActivityAction(action: string): string {
  return ACTIVITY_ACTION_LABELS[action] ?? action;
}

function buildAuditTrailSection(data: VendorOnboardingPdfData): Content[] {
  const auditTable: Content =
    data.auditTrail.length > 0
      ? {
          table: {
            widths: ["20%", "27%", "23%", "30%"],
            body: [
              [
                { text: "Date & Time", style: LABEL_STYLE },
                { text: "Action", style: LABEL_STYLE },
                { text: "Performed By", style: LABEL_STYLE },
                { text: "Reason", style: LABEL_STYLE },
              ],
              ...data.auditTrail.map((entry) => [
                { text: displayDateTime(entry.createdAt) },
                { text: displayActivityAction(entry.action) },
                { text: entry.performedBy },
                { text: displayValue(entry.reason) },
              ]),
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 16],
        }
      : {
          text: "No activity recorded yet.",
          italics: true,
          margin: [0, 0, 0, 16],
        };

  return [{ text: "Audit Trail", style: SECTION_HEADER_STYLE }, auditTable];
}

// Explicit `: Content` (and, for the footer, its full function-signature)
// return types below are load-bearing, not decorative — without them, TS
// widens the `margin` tuple literal to `number[]`, which pdfmake's Margins
// type rejects. buildTwoColumnTable/buildDocumentsSection avoid this the
// same way, just implicitly: their surrounding `Content`-typed variable or
// return position already gives the array literal its tuple context.

function buildLetterheadHeader(subtitle: string): Content {
  return {
    margin: [40, 20, 40, 0],
    columns: [
      {
        text: "Tata Hitachi Construction Machinery",
        style: "letterheadTitle",
      },
      {
        text: subtitle,
        style: "letterheadSubtitle",
        alignment: "right" as const,
      },
    ],
  };
}

// `statusLabel` is printed as-is — callers decide what it says. The
// internal copy passes the dynamic "pending on" label (see
// buildVendorOnboardingDocDefinition below); the vendor copy keeps passing
// the raw status enum, unchanged.
function buildStatusFooter(
  statusLabel: string,
): (currentPage: number, pageCount: number) => Content {
  return (currentPage: number, pageCount: number): Content => ({
    margin: [40, 0, 40, 20],
    columns: [
      { text: `Status: ${statusLabel}`, style: "footerText" },
      {
        text: `Page ${currentPage} of ${pageCount}`,
        alignment: "right" as const,
        style: "footerText",
      },
    ],
  });
}

// ── internal / employee copy — everything ─────────────────────────────────

export function buildVendorOnboardingDocDefinition(
  data: VendorOnboardingPdfData,
): TDocumentDefinitions {
  return {
    pageSize: "A4",
    pageMargins: [40, 100, 40, 60],
    header: buildLetterheadHeader("Vendor Onboarding Record"),
    // Dynamic status — reuses the same computePendingOn/
    // resolveVendorOnboardingPendingOn result the listing/detail endpoints
    // already compute (assembled once in vendorOnboardingAssembler.ts),
    // rather than the raw status enum.
    footer: buildStatusFooter(displayPendingOn(data.pendingOn)),

    content: [
      ...buildVendorDetailsSection(data),
      ...buildBankDetailsSection(data),
      ...buildProcurementDetailsSection(data),
      ...buildDocumentsSection(data),
      ...buildWorkflowSection(data),
      ...buildAuditTrailSection(data),
      {
        text: `Generated on ${displayDate(data.generatedAt)}`,
        style: "footerText",
        margin: [0, 8, 0, 0],
      },
    ],

    styles: STYLES,
    defaultStyle: DEFAULT_STYLE,
  };
}

// ── vendor-facing copy — vendor-submitted fields only ─────────────────────
// No Procurement Details, Workflow, or Audit Trail sections: those are
// either employee-owned fields the vendor never provided, or internal
// approver identities/history — neither belongs on the public view link.
// Status footer stays the raw enum, not the approver-naming dynamic label.

export function buildVendorOnboardingVendorCopyDocDefinition(
  data: VendorOnboardingPdfData,
): TDocumentDefinitions {
  return {
    pageSize: "A4",
    pageMargins: [40, 100, 40, 60],
    header: buildLetterheadHeader("Vendor Submission Copy"),
    footer: buildStatusFooter(data.status),

    content: [
      ...buildVendorDetailsSection(data),
      ...buildBankDetailsSection(data),
      ...buildDocumentsSection(data),
      {
        text: `Generated on ${displayDate(data.generatedAt)}`,
        style: "footerText",
        margin: [0, 8, 0, 0],
      },
    ],

    styles: STYLES,
    defaultStyle: DEFAULT_STYLE,
  };
}

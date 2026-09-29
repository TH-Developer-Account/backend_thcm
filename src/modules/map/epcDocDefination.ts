import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import { EpcPdfData } from "./epcAssembler";
import {
  displayValue,
  displayBoolean,
  displayDate,
} from "@pdf/pdfFieldFormatter";

// ─────────────────────────────────────────────────────────────────────────────
// EPC — DOC DEFINITION BUILDER
//
// Pure function: EpcPdfData in, pdfmake TDocumentDefinitions out. No I/O, no
// S3, no rendering — just layout. Mirrors vendorOnboardingDocDofination.ts's
// section/table conventions; adds Workflow, Comments, and Activity Log
// sections that the other two document types don't currently need.
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEADER_STYLE = "sectionHeader";
const LABEL_STYLE = "fieldLabel";

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

function buildLineItemsTable(
  lineItems: Array<{
    productName: string;
    quantity: number | null;
    amount: number | null;
  }>,
): Content {
  if (lineItems.length === 0) {
    return { text: "No line items.", italics: true, margin: [0, 0, 0, 16] };
  }
  return {
    table: {
      widths: ["50%", "25%", "25%"],
      body: [
        [
          { text: "Product", style: LABEL_STYLE },
          { text: "Quantity", style: LABEL_STYLE },
          { text: "Amount", style: LABEL_STYLE },
        ],
        ...lineItems.map((li) => [
          { text: li.productName },
          { text: displayValue(li.quantity) },
          { text: displayValue(li.amount) },
        ]),
      ],
    },
    layout: "lightHorizontalLines",
    margin: [0, 0, 0, 16],
  };
}

function buildWorkflowSection(workflow: EpcPdfData["workflow"]): Content[] {
  if (!workflow) {
    return [
      { text: "Workflow", style: SECTION_HEADER_STYLE },
      { text: "No active workflow.", italics: true, margin: [0, 0, 0, 16] },
    ];
  }

  const stageBlocks: Content[] = workflow.stages.map((stage) => {
    const approvalsBlock: Content =
      stage.approvals.length > 0
        ? {
            table: {
              widths: ["50%", "25%", "25%"],
              body: [
                [
                  { text: "Approver", style: LABEL_STYLE },
                  { text: "Status", style: LABEL_STYLE },
                  { text: "External", style: LABEL_STYLE },
                ],
                ...stage.approvals.map((a) => [
                  { text: a.approverName },
                  { text: a.status },
                  { text: displayBoolean(a.isExternalApprover) },
                ]),
              ],
            },
            layout: "lightHorizontalLines",
          }
        : { text: "No approvers assigned.", italics: true };

    const stageStack: Content[] = [
      {
        text: `Stage ${stage.stageOrder}: ${displayValue(stage.stageName)} — ${stage.status}`,
        bold: true,
        margin: [0, 6, 0, 4],
      },
      approvalsBlock,
    ];

    return { stack: stageStack, margin: [0, 0, 0, 8] };
  });

  return [
    { text: "Workflow", style: SECTION_HEADER_STYLE },
    buildTwoColumnTable([
      fieldRow("Template", displayValue(workflow.templateName)),
      fieldRow("Status", displayValue(workflow.status)),
    ]),
    ...stageBlocks,
  ];
}

function buildCommentsSection(comments: EpcPdfData["comments"]): Content[] {
  if (comments.length === 0) {
    return [
      { text: "Comments", style: SECTION_HEADER_STYLE },
      { text: "No comments.", italics: true, margin: [0, 0, 0, 16] },
    ];
  }

  return [
    { text: "Comments", style: SECTION_HEADER_STYLE },
    {
      table: {
        widths: ["20%", "20%", "20%", "40%"],
        body: [
          [
            { text: "Date", style: LABEL_STYLE },
            { text: "By", style: LABEL_STYLE },
            { text: "Stage", style: LABEL_STYLE },
            { text: "Message", style: LABEL_STYLE },
          ],
          ...comments.map((c) => [
            { text: displayDate(c.createdAt) },
            { text: c.actorName },
            { text: displayValue(c.stageName) },
            { text: c.message },
          ]),
        ],
      },
      layout: "lightHorizontalLines",
      margin: [0, 0, 0, 16],
    },
  ];
}

function buildActivityLogSection(
  activityLog: EpcPdfData["activityLog"],
): Content[] {
  if (activityLog.length === 0) {
    return [
      { text: "Activity Log", style: SECTION_HEADER_STYLE },
      { text: "No activity recorded.", italics: true, margin: [0, 0, 0, 16] },
    ];
  }

  return [
    { text: "Activity Log", style: SECTION_HEADER_STYLE },
    {
      table: {
        widths: ["20%", "25%", "20%", "35%"],
        body: [
          [
            { text: "Date", style: LABEL_STYLE },
            { text: "Action", style: LABEL_STYLE },
            { text: "By", style: LABEL_STYLE },
            { text: "Stage", style: LABEL_STYLE },
          ],
          ...activityLog.map((a) => [
            { text: displayDate(a.createdAt) },
            { text: a.action },
            { text: a.actorName },
            { text: displayValue(a.stageName) },
          ]),
        ],
      },
      layout: "lightHorizontalLines",
      margin: [0, 0, 0, 16],
    },
  ];
}

export function buildEpcDocDefinition(data: EpcPdfData): TDocumentDefinitions {
  const epcRows = [
    fieldRow("Proposal Number", displayValue(data.epc.proposalNumber)),
    fieldRow("Event Name", displayValue(data.epc.eventName)),
    fieldRow(
      "Event Dates",
      `${displayDate(data.epc.eventFromDate)} to ${displayDate(data.epc.eventToDate)}`,
    ),
    fieldRow("Location", displayValue(data.epc.location)),
    fieldRow("Description", displayValue(data.epc.eventDescription)),
    fieldRow("Objective", displayValue(data.epc.eventObjective)),
    fieldRow("Status", displayValue(data.epc.status)),
    fieldRow("Department", displayValue(data.epc.department)),
    fieldRow("Vertical", displayValue(data.epc.vertical)),
    fieldRow("Region", displayValue(data.epc.region)),
    fieldRow("Branch", displayValue(data.epc.branch)),
    fieldRow("Budget Master", displayValue(data.epc.budgetMaster)),
    fieldRow("Created By", displayValue(data.epc.createdBy)),
    fieldRow("Deviation Reason", displayValue(data.epc.deviationReason)),
    fieldRow("Deviation Amount", displayValue(data.epc.deviationAmount)),
  ];

  const epfRows = data.epf
    ? [
        fieldRow(
          "External Participants",
          displayValue(data.epf.externalParticipants),
        ),
        fieldRow(
          "Internal Participants",
          displayValue(data.epf.internalParticipants),
        ),
        fieldRow("Event Budget", displayValue(data.epf.eventBudget)),
        fieldRow("Annual Budget", displayValue(data.epf.annualBudget)),
        fieldRow("Available Budget", displayValue(data.epf.availableBudget)),
        fieldRow("Dealer Name", displayValue(data.epf.dealerName)),
        fieldRow("Dealer Percent", displayValue(data.epf.dealerPercent)),
        fieldRow("Dealer Share", displayValue(data.epf.dealerShare)),
        fieldRow(
          "Tata Hitachi PO Amount",
          displayValue(data.epf.tataHitachiPoAmount),
        ),
        fieldRow("EPF Status", displayValue(data.epf.status)),
      ]
    : null;

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
          text: "Event Proposal (EPC) Record",
          style: "letterheadSubtitle",
          alignment: "right",
        },
      ],
    },

    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 0, 40, 20],
      columns: [
        { text: `Status: ${data.epc.status}`, style: "footerText" },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          alignment: "right",
          style: "footerText",
        },
      ],
    }),

    content: [
      { text: "EPC Details", style: SECTION_HEADER_STYLE },
      buildTwoColumnTable(epcRows),

      { text: "EPF Details", style: SECTION_HEADER_STYLE },
      epfRows
        ? buildTwoColumnTable(epfRows)
        : { text: "No EPF submitted.", italics: true, margin: [0, 0, 0, 16] },
      ...(data.epf
        ? [
            { text: "EPF Line Items", style: SECTION_HEADER_STYLE } as Content,
            buildLineItemsTable(data.epf.lineItems),
          ]
        : []),

      { text: "CRF Details", style: SECTION_HEADER_STYLE },
      data.crf
        ? buildLineItemsTable(data.crf.lineItems)
        : { text: "No CRF submitted.", italics: true, margin: [0, 0, 0, 16] },

      ...buildWorkflowSection(data.workflow),
      ...buildCommentsSection(data.comments),
      ...buildActivityLogSection(data.activityLog),

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

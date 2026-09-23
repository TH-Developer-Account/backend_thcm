import type { TDocumentDefinitions, TableCell } from "pdfmake/interfaces";
import { FactoryAuditPdfData } from "./factoryAuditAssembler";

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY AUDIT — DOC DEFINITION BUILDER
//
// Pure function: FactoryAuditPdfData in, pdfmake TDocumentDefinitions out.
// Same shape as dealerAuditDocDefinition.ts/vendorOnboardingDocDofination.ts
// — no I/O, no S3, no rendering, just layout.
// ─────────────────────────────────────────────────────────────────────────────

function scoreCell(score: number | null): string {
  return score == null ? "N/A" : score.toString();
}

function sectionHeaderRow(
  section: FactoryAuditPdfData["sections"][number],
): TableCell[] {
  const status = section.passed ? "PASSED" : "FAILED";

  // colSpan/rowSpan live on pdfmake's TableCellProperties, not on Content
  // itself — a table body cell's real type is
  // `TableCell = {} | (Content & TableCellProperties)`. Typing this as
  // plain `Content` (an earlier attempt) still excluded colSpan; typing
  // it as `TableCell` is what actually has it.
  const headerCell: TableCell = {
    text: `${section.sectionName}  —  ${section.percent.toFixed(1)}% (min ${section.passThreshold.toFixed(0)}%) — ${status}`,
    colSpan: 4,
    style: section.passed ? "sectionHeaderPass" : "sectionHeaderFail",
    margin: [0, 8, 0, 4],
  };

  // Columns covered by a colSpan still need a placeholder entry — pdfmake's
  // own docs specify an empty object `{}`, not an empty string.
  return [headerCell, {}, {}, {}];
}

export function buildFactoryAuditDocDefinition(
  data: FactoryAuditPdfData,
): TDocumentDefinitions {
  const body: TableCell[][] = [
    [
      { text: "Check Point", style: "tableHeader" },
      { text: "Weight", style: "tableHeader" },
      { text: "Score", style: "tableHeader" },
      { text: "Reviewer Remark", style: "tableHeader" },
    ],
  ];

  for (const section of data.sections) {
    body.push(sectionHeaderRow(section));
    for (const checkpoint of section.checkpoints) {
      body.push([
        checkpoint.label,
        checkpoint.weight.toString(),
        scoreCell(checkpoint.score),
        [
          checkpoint.reviewerFlaggedForImprovement
            ? "⚑ Flagged for improvement. "
            : "",
          checkpoint.reviewerRemark ?? "",
        ]
          .join("")
          .trim() || "—",
      ]);
    }
  }

  return {
    content: [
      { text: "Factory Audit Report", style: "header" },
      {
        columns: [
          [
            { text: `Vendor: ${data.vendorName} (${data.vendorCode})` },
            { text: `Process Category: ${data.processCategory}` },
            {
              text: `Target Part Categories: ${data.targetPartCategories.join(", ") || "—"}`,
            },
          ],
          [
            { text: `Template: ${data.templateName}` },
            { text: `Generated: ${data.generatedAt.toDateString()}` },
          ],
        ],
        margin: [0, 0, 0, 16],
      },
      {
        text: `Overall Score: ${data.overallPercent.toFixed(1)}%  —  Classification: ${data.bandLabel}`,
        style: "subheader",
        margin: [0, 0, 0, 4],
      },
      {
        text: `Qualifies For: ${data.qualifiesFor.length ? data.qualifiesFor.join(", ") : "None"}`,
        margin: [0, 0, 0, 12],
      },
      {
        table: {
          headerRows: 1,
          widths: ["*", "10%", "10%", "30%"],
          body,
        },
        layout: "lightHorizontalLines",
      },
    ],
    styles: {
      header: { fontSize: 18, bold: true, margin: [0, 0, 0, 12] },
      subheader: { fontSize: 13, bold: true },
      tableHeader: { bold: true, fillColor: "#eeeeee" },
      sectionHeaderPass: { bold: true, fillColor: "#e6f4ea" },
      sectionHeaderFail: { bold: true, fillColor: "#fbe9e7" },
    },
    defaultStyle: { fontSize: 9 },
  };
}

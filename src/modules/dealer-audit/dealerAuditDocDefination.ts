import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { DealerAuditPdfData } from "./dealerAuditAssembler";

export function buildDealerAuditDocDefinition(
  data: DealerAuditPdfData,
): TDocumentDefinitions {
  const percent =
    data.maxScore > 0 ? Math.round((data.totalScore / data.maxScore) * 100) : 0;

  return {
    content: [
      { text: "Dealer Audit Report", style: "header" },
      {
        columns: [
          [
            { text: `Dealer: ${data.dealerName}` },
            { text: `Office Type: ${data.officeType}` },
          ],
          [
            { text: `Template: ${data.templateName}` },
            { text: `Period: ${data.periodLabel}` },
            {
              text: `Closed: ${data.closedAt ? data.closedAt.toDateString() : "—"}`,
            },
          ],
        ],
        margin: [0, 0, 0, 16],
      },
      {
        text: `Overall Score: ${data.totalScore} / ${data.maxScore} (${percent}%)`,
        style: "subheader",
        margin: [0, 0, 0, 12],
      },
      {
        table: {
          headerRows: 1,
          widths: ["18%", "*", "10%", "10%", "*"],
          body: [
            [
              { text: "Section", style: "tableHeader" },
              { text: "Check Point", style: "tableHeader" },
              { text: "Dealer", style: "tableHeader" },
              { text: "Reviewer", style: "tableHeader" },
              { text: "Reviewer Remark", style: "tableHeader" },
            ],
            ...data.items.map((item) => [
              item.sectionName,
              item.label,
              item.dealerScore?.toString() ?? "—",
              item.reviewerScore?.toString() ?? "—",
              item.reviewerRemark ?? "—",
            ]),
          ],
        },
        layout: "lightHorizontalLines",
      },
    ],
    styles: {
      header: { fontSize: 18, bold: true, margin: [0, 0, 0, 12] },
      subheader: { fontSize: 13, bold: true },
      tableHeader: { bold: true, fillColor: "#eeeeee" },
    },
    defaultStyle: { fontSize: 9 },
  };
}

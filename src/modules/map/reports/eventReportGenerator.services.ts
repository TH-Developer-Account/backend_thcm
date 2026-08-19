import { prisma } from "@shared/config/prisma";
import {
  downloadFromS3,
  uploadBufferToS3,
} from "@shared/utils/aws-s3.services";
import { renderPdfBuffer } from "@pdf/pdfRenderEngine";
import { notify } from "@notifications/notification.services";
import { resolveWorkspaceId } from "@import-export/export.controller";
import { resolveEventReportTemplate } from "./eventReportTemplate.registry";
import { resolveEventReportData, ResolvedField } from "./eventReportAggregator";
import { buildEventReportDocDefinition } from "./eventReportDocBuilder";
import { EventReportTemplateConfig } from "./eventReportTemplate.types";

// ── Report title/subtitle composition ─────────────────────────────────────────
//
// WHY this lives here, not in eventReportDocBuilder.ts:
//   The doc builder stays a pure "already-resolved data → pdfmake doc" layer
//   with no opinions about which resolved field means what. Deciding "the
//   title comes from the field labeled Event" is a report-content policy,
//   which belongs in the orchestrator that already knows about templates
//   and sourceType.
//
// Title: every template's inputFields includes a shared "Event" field
// (source: EPC_FIELD event_name.title) — reused directly as the report
// title, since real EventName titles already read like report titles
// ("Stand Alone Fuel & Production Study", "Customer Meet", etc.).
//
// Subtitle (Option A — confirmed): only composed for DATA_FORM templates,
// as "{Machine Model} in {Application}", since those are the only
// templates with resolved fields to compose from. LEAD_FORM templates get
// no subtitle. This matches field labels defined in
// eventReportTemplate.defination.ts — if those labels are ever renamed,
// this lookup silently returns null rather than throwing, so a renamed
// label just drops the subtitle rather than breaking generation.

function findFieldValue(
  fields: ResolvedField[],
  reportLabel: string,
): string | null {
  const field = fields.find((f) => f.reportLabel === reportLabel);
  if (!field || !("value" in field) || field.value == null) return null;
  return String(field.value);
}

function composeReportTitle(inputFields: ResolvedField[]): string {
  return findFieldValue(inputFields, "Event") ?? "Event Report";
}

function composeReportSubtitle(
  template: EventReportTemplateConfig,
  inputFields: ResolvedField[],
): string | null {
  if (template.sourceType !== "DATA_FORM") return null;

  const model = findFieldValue(inputFields, "Machine Model");
  const application = findFieldValue(inputFields, "Application");

  if (!model && !application) return null;
  if (model && application) return `${model} in ${application}`;
  return model ?? application;
}

export async function generateEventReport(reportId: string): Promise<void> {
  const report = await prisma.eventReport.findUnique({
    where: { id: reportId },
    include: {
      images: { orderBy: { position: "asc" } },
      epc: {
        select: {
          id: true,
          event_name_id: true,
          created_by_id: true,
          proposal_number: true,
        },
      },
    },
  });

  if (!report) {
    throw new Error(`EventReport not found: ${reportId}`);
  }

  const template = await resolveEventReportTemplate(report.epc.event_name_id);
  if (!template) {
    throw new Error(
      `No report template resolvable for EPC ${report.epc.id} at generation time`,
    );
  }

  // ── Resolve data ──────────────────────────────────────────────────────────
  const resolvedData = await resolveEventReportData(
    template,
    report.epc.id,
    report.eventHighlights,
  );

  // ── Persist computedOutcomes as an audit snapshot ──────────────────────────
  await prisma.eventReport.update({
    where: { id: reportId },
    data: {
      computedOutcomes: {
        inputFields: resolvedData.inputFields,
        outcomeFields: resolvedData.outcomeFields,
      } as any,
    },
  });

  // ── Fetch images for pdfmake — mimeType is read from the stored column,
  // set at submit/resubmit time from the actual uploaded file's mimetype. ──
  const imagesWithData = await Promise.all(
    report.images.map(async (img) => {
      const buffer = await downloadFromS3(img.s3Key);
      return {
        position: img.position,
        caption: img.caption,
        dataUri: `data:${img.mimeType};base64,${buffer.toString("base64")}`,
      };
    }),
  );

  // ── Compose title/subtitle (see note above) ─────────────────────────────────
  const reportTitle = composeReportTitle(resolvedData.inputFields);
  const reportSubtitle = composeReportSubtitle(
    template,
    resolvedData.inputFields,
  );

  // ── Build + render PDF ───────────────────────────────────────────────────
  const docDefinition = buildEventReportDocDefinition({
    proposalNumber: report.epc.proposal_number,
    reportTitle,
    reportSubtitle,
    inputFields: resolvedData.inputFields,
    outcomeFields: resolvedData.outcomeFields,
    dualVariant: template.dualVariant ?? false,
    eventHighlights: report.eventHighlights,
    images: imagesWithData,
  });

  const pdfBuffer = await renderPdfBuffer(docDefinition);
  const pdfS3Key = `event-reports/${reportId}.pdf`;
  await uploadBufferToS3(
    pdfS3Key,
    pdfBuffer,
    `report-${report.epc.proposal_number}.pdf`,
  );

  // ── Flip status, notify ────────────────────────────────────────────────────
  await prisma.eventReport.update({
    where: { id: reportId },
    data: { status: "SUBMITTED", pdfS3Key },
  });

  const workspaceId = await resolveWorkspaceId(report.epc.created_by_id);

  await notify({
    workspaceId,
    recipientId: report.epc.created_by_id,
    type: "REPORT_STATUS",
    title: "Event report generated",
    body: `Your report for EPC ${report.epc.proposal_number} is ready to view.`,
    link: `/report/${report.epc.id}`,
  });

  await notify({
    workspaceId,
    recipientId: report.validatorId,
    type: "APPROVAL_PENDING",
    title: "Event report ready for review",
    body: `A report for EPC ${report.epc.proposal_number} is awaiting your review.`,
    link: `/report/${report.epc.id}`,
  });
}

import { prisma } from "@shared/config/prisma";
import { EVENT_REPORT_TEMPLATES } from "./eventReportTemplate.defination";
import { EventReportTemplateConfig } from "./eventReportTemplate.types";

export async function resolveEventReportTemplate(
  eventNameId: string,
): Promise<EventReportTemplateConfig | null> {
  const eventName = await prisma.eventName.findUnique({
    where: { id: eventNameId },
    select: { reportTemplateKey: true },
  });

  if (!eventName?.reportTemplateKey) return null;
  return EVENT_REPORT_TEMPLATES[eventName.reportTemplateKey] ?? null;
}

// eventReportTemplate.registry.ts

export async function resolveEventReportFormConfig(epcId: string): Promise<{
  minImages: number;
  maxImages: number;
  dualVariant: boolean;
  sourceType: "LEAD_FORM" | "DATA_FORM";
} | null> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    select: { event_name_id: true },
  });
  if (!epc) return null;

  const template = await resolveEventReportTemplate(epc.event_name_id);
  if (!template) return null;

  return {
    minImages: template.minImages,
    maxImages: template.maxImages,
    dualVariant: template.dualVariant ?? false,
    sourceType: template.sourceType,
  };
}

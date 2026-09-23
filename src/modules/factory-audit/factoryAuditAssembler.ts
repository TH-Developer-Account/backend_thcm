import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { computeFactoryAuditClassification } from "./factoryAudit.helper";

// ─────────────────────────────────────────────────────────────────────────────
// factoryAuditAssembler.ts
//
// Data-fetch half of the FACTORY_AUDIT pdfDocumentRegistry entry — mirrors
// dealerAuditAssembler.ts's shape (assemble* in, PdfData out, no layout
// concerns). Reuses computeFactoryAuditClassification rather than
// re-deriving overallPercent/bandLabel here, so the report always shows
// exactly the same figures assignWorkflow's `criteria` was built from.
// ─────────────────────────────────────────────────────────────────────────────

export interface FactoryAuditPdfData {
  instanceId: string;
  vendorName: string;
  vendorCode: string;
  templateName: string;
  processCategory: string;
  targetPartCategories: string[];
  generatedAt: Date;
  overallPercent: number;
  bandLabel: string;
  qualifiesFor: string[];
  sections: {
    sectionName: string;
    percent: number;
    passThreshold: number;
    passed: boolean;
    checkpoints: {
      label: string;
      checkPoint: string;
      weight: number;
      score: number | null;
      reviewerFlaggedForImprovement: boolean;
      reviewerRemark: string | null;
    }[];
  }[];
}

export async function assembleFactoryAuditPdfData(
  instanceId: string,
): Promise<FactoryAuditPdfData> {
  const instance = await prisma.factoryAuditInstance.findUnique({
    where: { id: instanceId },
    include: {
      vendor: { select: { name: true, code: true } },
      template: {
        include: {
          sections: {
            orderBy: { order: "asc" },
            include: { checkpoints: { orderBy: { order: "asc" } } },
          },
        },
      },
      results: true,
    },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");

  const resultByCheckpointId = new Map(
    instance.results.map((r) => [r.checkpointId, r]),
  );
  const classification = await computeFactoryAuditClassification(instanceId);
  const classificationBySectionId = new Map(
    classification.sections.map((s) => [s.sectionId, s]),
  );

  const sections = instance.template.sections.map((section) => {
    // Falls back to a zeroed, "not passed" row only if a section somehow
    // has no AuditCheckpointResult rows yet (shouldn't happen — this PDF
    // is only ever generated after finalize) — defensive, not expected.
    const sectionClassification = classificationBySectionId.get(section.id) ?? {
      percent: 0,
      passThreshold: section.passThreshold * 100,
      passed: false,
    };

    return {
      sectionName: section.name,
      percent: sectionClassification.percent,
      passThreshold: sectionClassification.passThreshold,
      passed: sectionClassification.passed,
      checkpoints: section.checkpoints.map((checkpoint) => {
        const result = resultByCheckpointId.get(checkpoint.id);
        return {
          label: checkpoint.label,
          checkPoint: checkpoint.checkPoint,
          weight: checkpoint.weight,
          score: result?.score ?? null,
          reviewerFlaggedForImprovement:
            result?.reviewerFlaggedForImprovement ?? false,
          reviewerRemark: result?.reviewerRemark ?? null,
        };
      }),
    };
  });

  return {
    instanceId: instance.id,
    vendorName: instance.vendor.name,
    vendorCode: instance.vendor.code,
    templateName: instance.template.name,
    processCategory: instance.template.processCategory,
    targetPartCategories: instance.targetPartCategories,
    generatedAt: new Date(),
    overallPercent: classification.overallPercent,
    bandLabel: classification.bandLabel,
    qualifiesFor: classification.qualifiesFor,
    sections,
  };
}

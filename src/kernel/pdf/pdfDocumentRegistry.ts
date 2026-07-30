import type { TDocumentDefinitions } from "pdfmake/interfaces";
import {
  assembleVendorOnboardingPdfData,
  VendorOnboardingPdfData,
} from "@vendor-onboarding/vendorOnboardingAssembler";
import { buildVendorOnboardingDocDefinition } from "@vendor-onboarding/vendorOnboardingDocDofination";

// ─────────────────────────────────────────────────────────────────────────────
// PDF DOCUMENT REGISTRY
//
// Same pattern as workflowSubject.helper.ts: adding a new PDF document type
// means adding one entry here, not touching pdf.service.ts. Each entry wires
// together an assembler (data fetch), a docDefinition builder (layout), and
// an S3 key builder (storage location) for exactly one document type.
// ─────────────────────────────────────────────────────────────────────────────

export type PdfDocumentType = "VENDOR_ONBOARDING";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PdfDocumentDefinition<TData = any> {
  assembleData: (id: string) => Promise<TData>;
  buildDocDefinition: (data: TData) => TDocumentDefinitions;
  buildS3Key: (id: string) => string;
}

export const pdfDocumentRegistry: Record<
  PdfDocumentType,
  PdfDocumentDefinition
> = {
  VENDOR_ONBOARDING: {
    assembleData: assembleVendorOnboardingPdfData,
    buildDocDefinition: (data: VendorOnboardingPdfData) =>
      buildVendorOnboardingDocDefinition(data),
    buildS3Key: (onboardingId: string) =>
      `vendor-onboarding-pdfs/${onboardingId}.pdf`,
  },
};

export function resolvePdfDocumentDefinition(
  type: PdfDocumentType,
): PdfDocumentDefinition {
  const definition = pdfDocumentRegistry[type];
  if (!definition) {
    // Guards against a bad/typo'd type reaching here at runtime, even
    // though the PdfDocumentType union should prevent it at compile time.
    throw new Error(`No PDF document definition registered for type: ${type}`);
  }
  return definition;
}

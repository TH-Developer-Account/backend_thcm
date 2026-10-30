import type { TDocumentDefinitions } from "pdfmake/interfaces";
import {
  assembleVendorOnboardingPdfData,
  computeVendorOnboardingDocumentsCacheVersion,
  VendorOnboardingPdfData,
} from "@vendor-onboarding/vendorOnboardingAssembler";
import {
  buildVendorOnboardingDocDefinition,
  buildVendorOnboardingVendorCopyDocDefinition,
} from "@vendor-onboarding/vendorOnboardingDocDofination";
import {
  assembleMedicalClaimPdfData,
  MedicalClaimPdfData,
} from "@medi-claim/mediclaimAssembler";
import { buildMedicalClaimDocDefinition } from "@medi-claim/mediclaimDocDefination";

// ─────────────────────────────────────────────────────────────────────────────
// PDF DOCUMENT REGISTRY
//
// Same pattern as workflowSubject.helper.ts: adding a new PDF document type
// means adding one entry here, not touching pdf.service.ts. Each entry wires
// together an assembler (data fetch), a docDefinition builder (layout), and
// an S3 key builder (storage location) for exactly one document type.
//
// VENDOR_ONBOARDING and VENDOR_ONBOARDING_VENDOR_COPY intentionally share
// the same assembler — the underlying data is identical, only the layout
// (which sections get rendered) differs between the internal and
// vendor-facing copies.
//
// getAttachmentS3Keys / computeCacheVersion are both optional, per-type
// hooks (see pdf.services.ts for how they're used). Most document types
// define neither — MEDICAL_CLAIM and the vendor copy keep the original,
// zero-extra-cost cache-hit path untouched. Only VENDOR_ONBOARDING (the
// internal copy) defines both, to append the vendor's uploaded documents as
// extra pages and invalidate the cached PDF whenever those documents change.
// ─────────────────────────────────────────────────────────────────────────────

export type PdfDocumentType =
  | "VENDOR_ONBOARDING"
  | "VENDOR_ONBOARDING_VENDOR_COPY"
  | "MEDICAL_CLAIM";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PdfDocumentDefinition<TData = any> {
  assembleData: (id: string) => Promise<TData>;
  buildDocDefinition: (data: TData) => TDocumentDefinitions;
  buildS3Key: (id: string) => string;
  // S3 keys of user-uploaded files to append as extra pages after the
  // generated record pages. Omit (or return []) to skip merging entirely.
  getAttachmentS3Keys?: (data: TData) => string[];
  // Derives a short cache-key suffix from data that can change between
  // generations (e.g. the attached documents). Omit for types whose cached
  // PDF never needs invalidating beyond "does one already exist for this id".
  computeCacheVersion?: (data: TData) => string;
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
    getAttachmentS3Keys: (data: VendorOnboardingPdfData) =>
      data.documents.map((doc) => doc.s3Key),
    computeCacheVersion: computeVendorOnboardingDocumentsCacheVersion,
  },
  VENDOR_ONBOARDING_VENDOR_COPY: {
    assembleData: assembleVendorOnboardingPdfData,
    buildDocDefinition: (data: VendorOnboardingPdfData) =>
      buildVendorOnboardingVendorCopyDocDefinition(data),
    buildS3Key: (onboardingId: string) =>
      `vendor-onboarding-pdfs/${onboardingId}-vendor-copy.pdf`,
  },
  MEDICAL_CLAIM: {
    assembleData: assembleMedicalClaimPdfData,
    buildDocDefinition: (data: MedicalClaimPdfData) =>
      buildMedicalClaimDocDefinition(data),
    buildS3Key: (claimId: string) => `medical-claim-pdfs/${claimId}.pdf`,
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

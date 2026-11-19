import {
  uploadBufferToS3,
  getSignedReportUrl,
  objectExistsInS3,
} from "@shared/utils/aws-s3.services"; // adjust path to your actual location
import { renderPdfBuffer } from "./pdfRenderEngine";
import { appendAttachmentsToPdf } from "./pdfAttachmentMerger";
import {
  PdfDocumentType,
  PdfDocumentDefinition,
  resolvePdfDocumentDefinition,
} from "./pdfDocumentRegistry";

const PRESIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — AWS max

// ─────────────────────────────────────────────────────────────────────────────
// renderAndUploadPdf
//
// Shared by both branches of getOrGeneratePdfUrl below: build the layout,
// render it, append any attachments this document type defines, and upload
// the result. Split out purely so neither branch duplicates this sequence.
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderAndUploadPdf(
  type: PdfDocumentType,
  recordId: string,
  data: any,
  definition: PdfDocumentDefinition,
  s3Key: string,
): Promise<void> {
  const docDefinition = definition.buildDocDefinition(data);
  const renderedBuffer = await renderPdfBuffer(docDefinition);

  // appendAttachmentsToPdf already no-ops on an empty array, so there's no
  // need to branch on definition.getAttachmentS3Keys here as well.
  const attachmentS3Keys = definition.getAttachmentS3Keys?.(data) ?? [];
  const pdfBuffer = await appendAttachmentsToPdf(
    renderedBuffer,
    attachmentS3Keys,
  );

  await uploadBufferToS3(
    s3Key,
    pdfBuffer,
    `${type.toLowerCase()}-${recordId}.pdf`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getOrGeneratePdfUrl
//
// Orchestration only — delegates every step to a focused module:
//   1. Resolve which assembler/builder/key applies for this document type
//      (registry — no conditionals here, and none needed when new types
//      are added later)
//   2. Cache check — if the PDF already exists at its S3 key, skip straight
//      to presigning (no re-render, no re-upload, no attachment merge)
//   3. Otherwise: assemble data → build layout → render → merge attachments
//      (if this type defines any) → upload → presign
//
// Two cache strategies, picked per document type via `computeCacheVersion`
// on its registry entry:
//   - No computeCacheVersion (MEDICAL_CLAIM, the vendor copy): deterministic
//     id-only key, exactly as before this change — a cache hit costs zero
//     DB queries.
//   - computeCacheVersion defined (VENDOR_ONBOARDING, the internal copy):
//     the key also encodes a fingerprint of the vendor's uploaded
//     documents, so adding/replacing an attachment after the first render
//     produces a new key instead of silently serving a PDF that's missing
//     the change. This costs one assembleData call even on a cache hit —
//     unavoidable, since the key itself depends on data that can change.
// ─────────────────────────────────────────────────────────────────────────────

export async function getOrGeneratePdfUrl(
  type: PdfDocumentType,
  recordId: string,
): Promise<string> {
  const definition = resolvePdfDocumentDefinition(type);
  const { assembleData, buildS3Key, computeCacheVersion } = definition;

  if (!computeCacheVersion) {
    const s3Key = buildS3Key(recordId);

    if (!(await objectExistsInS3(s3Key))) {
      const data = await assembleData(recordId);
      await renderAndUploadPdf(type, recordId, data, definition, s3Key);
    }

    return getSignedReportUrl(s3Key, PRESIGNED_URL_TTL_SECONDS);
  }

  const data = await assembleData(recordId);
  const s3Key = `${buildS3Key(recordId)}.v${computeCacheVersion(data)}`;

  if (!(await objectExistsInS3(s3Key))) {
    await renderAndUploadPdf(type, recordId, data, definition, s3Key);
  }

  return getSignedReportUrl(s3Key, PRESIGNED_URL_TTL_SECONDS);
}

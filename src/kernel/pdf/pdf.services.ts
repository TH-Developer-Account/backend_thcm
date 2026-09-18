import {
  uploadBufferToS3,
  getSignedReportUrl,
  objectExistsInS3,
} from "@shared/utils/aws-s3.services"; // adjust path to your actual location
import { renderPdfBuffer } from "./pdfRenderEngine";
import {
  PdfDocumentType,
  resolvePdfDocumentDefinition,
} from "./pdfDocumentRegistry";

const PRESIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — AWS max

// ─────────────────────────────────────────────────────────────────────────────
// getOrGeneratePdfUrl
//
// Orchestration only — delegates every step to a focused module:
//   1. Resolve which assembler/builder/key applies for this document type
//      (registry — no conditionals here, and none needed when new types
//      are added later)
//   2. Cache check — if the PDF already exists at its deterministic S3 key,
//      skip straight to presigning (no re-render, no re-upload)
//   3. Otherwise: assemble data → build layout → render → upload → presign
//
// Deterministic S3 key + overwrite-on-regenerate (per current requirements —
// no versioning). If versioning is needed later, only buildS3Key changes.
// ─────────────────────────────────────────────────────────────────────────────

export async function getOrGeneratePdfUrl(
  type: PdfDocumentType,
  recordId: string,
): Promise<string> {
  const { assembleData, buildDocDefinition, buildS3Key } =
    resolvePdfDocumentDefinition(type);

  const s3Key = buildS3Key(recordId);

  const alreadyExists = await objectExistsInS3(s3Key);

  if (!alreadyExists) {
    const data = await assembleData(recordId);
    const docDefinition = buildDocDefinition(data);
    const pdfBuffer = await renderPdfBuffer(docDefinition);

    await uploadBufferToS3(
      s3Key,
      pdfBuffer,
      `${type.toLowerCase()}-${recordId}.pdf`,
    );
  }

  return getSignedReportUrl(s3Key, PRESIGNED_URL_TTL_SECONDS);
}

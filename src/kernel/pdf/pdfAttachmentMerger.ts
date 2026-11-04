import { PDFDocument, PDFImage } from "pdf-lib";
import path from "path";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────────
// PDF ATTACHMENT MERGER
//
// Appends user-uploaded attachments (vendor documents, deviation docs, etc.)
// to the end of an already-rendered record PDF, as extra pages:
//   - a PDF attachment's own pages are copied in as-is
//   - an image attachment (PNG/JPEG) becomes one A4 page with the image
//     scaled to fit and centered, so every page in the merged document is
//     the same size regardless of the source photo's resolution
//
// Pure with respect to layout (fitImageToA4, embedImageAttachment don't
// touch the network); appendAttachmentsToPdf itself does I/O (S3 downloads),
// so it stays the one function callers actually use.
// ─────────────────────────────────────────────────────────────────────────────

// Matches the A4 page size pdfmake renders for the record itself
// (buildVendorOnboardingDocDefinition's pageSize: "A4"), so attachment
// pages read as a continuation of the same document.
const A4_WIDTH_POINTS = 595.28;
const A4_HEIGHT_POINTS = 841.89;
const PAGE_MARGIN_POINTS = 40;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

// pdf-lib can only embed PNG/JPEG directly — which is exactly the set of
// image types vendor uploads are restricted to (validateVendorDocumentFile),
// so no format conversion is needed here.
async function embedImageAttachment(
  mergedDoc: PDFDocument,
  fileBuffer: Buffer,
  extension: string,
): Promise<PDFImage> {
  if (extension === ".png") {
    return mergedDoc.embedPng(fileBuffer);
  }

  return mergedDoc.embedJpg(fileBuffer); // .jpg / .jpeg
}

// Scales the image to fit inside an A4 page (minus margins), preserving
// aspect ratio, and centers it on the page. `scale` is capped at 1 so a
// small image is never stretched up past its native size.
function fitImageToA4(image: PDFImage): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
  const maxWidth = A4_WIDTH_POINTS - PAGE_MARGIN_POINTS * 2;
  const maxHeight = A4_HEIGHT_POINTS - PAGE_MARGIN_POINTS * 2;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);

  const width = image.width * scale;
  const height = image.height * scale;

  return {
    width,
    height,
    x: (A4_WIDTH_POINTS - width) / 2,
    y: (A4_HEIGHT_POINTS - height) / 2,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// appendAttachmentsToPdf
//
// Downloads each attachment from S3 and appends it to `baseBuffer`, in the
// order given. Returns `baseBuffer` unchanged when there's nothing to
// append, so callers don't need their own empty-array check.
//
// Any attachment type other than the ones validated at upload time
// (validateVendorDocumentFile: PNG/JPEG/JPG/PDF) is out of scope here — an
// unrecognized extension is treated as a bug upstream and throws, rather
// than silently skipping a page the caller expected to see.
// ─────────────────────────────────────────────────────────────────────────────
export async function appendAttachmentsToPdf(
  baseBuffer: Buffer,
  attachmentS3Keys: string[],
): Promise<Buffer> {
  if (attachmentS3Keys.length === 0) return baseBuffer;

  const mergedDoc = await PDFDocument.load(baseBuffer);

  for (const s3Key of attachmentS3Keys) {
    const fileBuffer = await downloadFromS3(s3Key);
    const extension = path.extname(s3Key).toLowerCase();

    if (extension === ".pdf") {
      const attachmentDoc = await PDFDocument.load(fileBuffer);
      const copiedPages = await mergedDoc.copyPages(
        attachmentDoc,
        attachmentDoc.getPageIndices(),
      );
      copiedPages.forEach((page) => mergedDoc.addPage(page));
      continue;
    }

    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(
        `Cannot merge attachment "${s3Key}": unsupported file extension "${extension}"`,
      );
    }

    const image = await embedImageAttachment(mergedDoc, fileBuffer, extension);
    const page = mergedDoc.addPage([A4_WIDTH_POINTS, A4_HEIGHT_POINTS]);
    const { width, height, x, y } = fitImageToA4(image);
    page.drawImage(image, { x, y, width, height });
  }

  const mergedBytes = await mergedDoc.save();
  return Buffer.from(mergedBytes);
}

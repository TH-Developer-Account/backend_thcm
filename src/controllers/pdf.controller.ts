import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";
import { getOrGeneratePdfUrl } from "../services/pdf.services";
import {
  PdfDocumentType,
  pdfDocumentRegistry,
} from "../helpers/pdf-generator-helper/pdfDocumentRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// GET /pdf/:type/:id/url
//
// Returns a fresh presigned URL for the requested document's PDF,
// generating it first if it doesn't exist yet in S3.
// ─────────────────────────────────────────────────────────────────────────────

function isValidPdfDocumentType(value: string): value is PdfDocumentType {
  return value in pdfDocumentRegistry;
}

export const getPdfUrl = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { type, id } = req.params;

    if (!type || !isValidPdfDocumentType(type as string)) {
      throw new ApiError(400, `Unsupported PDF document type: ${type}`);
    }
    if (!id) throw new ApiError(400, "id is required");

    // TODO: add per-type authorization check here once roles are confirmed
    // (e.g. only the initiator/approver of this vendor onboarding record).

    const url = await getOrGeneratePdfUrl(
      type as PdfDocumentType,
      id as string,
    );

    res.status(200).json({ success: true, url });
  } catch (error) {
    next(error);
  }
};

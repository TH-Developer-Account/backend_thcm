import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import {
  LINE_ITEM_ATTACHMENT_MIME_TYPES,
  buildLineItemAttachmentS3Key,
  diffOrphanedAttachmentKeys,
  withLineItemAttachmentUrls,
  deleteOrphanedAttachments,
} from "./helpers/lineItemAttachement.helper";

// Payload to be sent

// {
//   "epcId": "uuid",

//   "total_budget": 200000,
//   "expected_revenue": 300000,

//   "lineItems": [
//     {
//       "productId": "uuid",
//       "amount": 15000,
//       "attachmentS3Key": "epf/<epcId>/line-items/<uuid>.jpg",   // optional, from POST /epf/line-item/attachment
//       "attachmentFileName": "quotation.jpg"                      // optional
//     },
//     {
//       "productId": "uuid",
//       "amount": 42000
//     }
//   ]
// }

// Overhead line-item amount: the proposer types a single ₹ figure per line
// (what this overhead actually costs) — it is never quantity × a catalog
// rate. ProductMaster.unitRate was only ever a placeholder for these rows,
// so it is no longer read here at all. This mirrors the same trusted
// client-snapshot pattern crf.service.ts's buildShopifyItemRows uses for
// souvenir `amount` — validated for sanity, never recomputed server-side.
const toValidatedAmount = (value: unknown): number => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ApiError(
      400,
      "amount must be a non-negative number for an overhead line",
    );
  }
  return amount;
};

export const createEPF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { epcId, lineItems, ...epfData } = req.body;

    const proposal = await prisma.eventProposal.findUnique({
      where: { id: epcId },
    });

    if (!proposal) {
      throw new ApiError(404, "Event Proposal not found");
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Create EPF
      const epf = await tx.ePF.create({
        data: {
          epcId,
          ...epfData,
        },
      });

      // 2️⃣ Validate products exist (identity only — no rate lookup)
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 3️⃣ Prepare line items — amount comes straight from the proposer's
      // input; there is no quantity or catalog rate behind an overhead line.
      // attachmentS3Key/attachmentFileName are optional — set only when the
      // proposer uploaded a file via POST /epf/line-item/attachment first.
      const lineItemsData = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);

        if (!product) throw new ApiError(400, "Invalid product");

        const amount = toValidatedAmount(item.amount);

        return {
          epfId: epf.id,
          crfId: null, // ✅ important
          productId: product.id,
          quantity: 1,
          rate: null,
          amount,
          attachmentS3Key: item.attachmentS3Key ?? null,
          attachmentFileName: item.attachmentFileName ?? null,
        };
      });

      // 4️⃣ Insert line items
      await tx.lineItem.createMany({
        data: lineItemsData,
      });

      // ── Step 5: Update EPC to submitted ────────────────────────────────────────
      await tx.eventProposal.update({
        where: { id: epcId },
        data: { status: "SUBMITTED" },
      });

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: epcId,
          actorId: req.user?.id as string,
          action: "EPF_CREATED",
          workflowId: null,
          stageId: null,
          metadata: {
            reason: "EPF is Created.",
          },
        },
      });

      return epf;
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

// Payload to be sent

// {
//   "total_budget": 250000,

//   "lineItems": [
//     {
//       "productId": "uuid1",
//       "amount": 18000,
//       "attachmentS3Key": "epf/<epcId>/line-items/<uuid>.pdf",
//       "attachmentFileName": "quotation.pdf"
//     },
//     {
//       "productId": "uuid2",
//       "amount": 51000
//     }
//   ]
// }

export const updateEPF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { epfId } = req.params;
    const { lineItems, ...epfData } = req.body;

    if (!epfId) {
      throw new ApiError(
        404,
        "EPF Id is mandatory, Please send the correct EPF Id!",
      );
    }

    // Collected inside the transaction, read after it commits — S3 deletes
    // must never run against keys a rolled-back transaction didn't actually
    // detach from a line item.
    let orphanedAttachmentKeys: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Update EPF fields
      const epf = await tx.ePF.update({
        where: { id: epfId as string },
        data: epfData,
      });

      // 2️⃣ Existing line items are about to be replaced wholesale (delete +
      // recreate below) — snapshot their attachment keys first so we can
      // tell which ones this save is orphaning.
      const existingLineItems = await tx.lineItem.findMany({
        where: { epfId: epfId as string },
        select: { attachmentS3Key: true },
      });

      // 3️⃣ Delete existing line items
      await tx.lineItem.deleteMany({
        where: { epfId: epfId as string },
      });

      // 4️⃣ Validate products exist (identity only — no rate lookup)
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 5️⃣ Recreate line items — amount comes straight from the proposer's
      // input; there is no quantity or catalog rate behind an overhead line.
      const newItems = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);

        if (!product) throw new ApiError(400, "Invalid product");

        const amount = toValidatedAmount(item.amount);

        return {
          epfId,
          crfId: null,
          productId: product.id,
          quantity: 1,
          rate: null,
          amount,
          attachmentS3Key: item.attachmentS3Key ?? null,
          attachmentFileName: item.attachmentFileName ?? null,
        };
      });

      await tx.lineItem.createMany({
        data: newItems,
      });

      orphanedAttachmentKeys = diffOrphanedAttachmentKeys(
        existingLineItems.map((item) => item.attachmentS3Key),
        lineItems.map((item: Record<string, string>) => item.attachmentS3Key),
      );

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: epf.epcId,
          actorId: req.user?.id as string,
          action: "EPF_UPDATED",
          workflowId: null,
          stageId: null,
          metadata: {
            reason: "EPF is Updated.",
          },
        },
      });

      return epf;
    });

    // Fire-and-forget-but-logged: the DB write already succeeded, so a
    // failed S3 delete here must never surface as a failure to the caller.
    if (orphanedAttachmentKeys.length > 0) {
      void deleteOrphanedAttachments(orphanedAttachmentKeys);
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const getEPFById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { epfId } = req.params;

    if (!epfId) {
      throw new ApiError(
        404,
        "EPF Id is mandatory, Please send the correct EPF Id!",
      );
    }

    const epf = await prisma.ePF.findUnique({
      where: { id: epfId as string },
      include: {
        epc: true,
        lineItems: {
          include: {
            product: true,
          },
          orderBy: {
            created_at: "asc",
          },
        },
      },
    });

    if (!epf) {
      throw new ApiError(404, "EPF not found");
    }

    // S3 keys are stored, not URLs — resolve a fresh pre-signed URL per
    // line item on every read (see lineItemAttachment.helper.ts).
    const lineItemsWithAttachmentUrls = await withLineItemAttachmentUrls(
      epf.lineItems,
    );

    res.status(200).json({ ...epf, lineItems: lineItemsWithAttachmentUrls });
  } catch (error) {
    next(error);
  }
};

// Single-file upload for one EPF line item's attachment. Upload-first: the
// proposer picks a file before the line item (and often before the EPF
// itself) exists, so this returns an S3 key the client then threads through
// as lineItems[].attachmentS3Key on the subsequent createEPF/updateEPF call
// — same shape the frontend's LineItemTable draft state already expects
// (quotationFile/quotationFileUrl/quotationFileName).
//
// Mime type + size are enforced by multer (fileFilter + limits) in
// epf.routes.ts before this handler ever runs.
export const uploadLineItemAttachment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { epcId } = req.body;

    if (!epcId) {
      throw new ApiError(400, "epcId is required");
    }

    if (!req.file) {
      throw new ApiError(400, "A file is required");
    }

    if (!LINE_ITEM_ATTACHMENT_MIME_TYPES[req.file.mimetype]) {
      throw new ApiError(400, "Only JPEG images or PDF files are accepted");
    }

    const s3Key = buildLineItemAttachmentS3Key(epcId, req.file.mimetype);

    await uploadToS3(s3Key, req.file.buffer, req.file.mimetype);

    res.status(200).json({
      data: { s3Key, fileName: req.file.originalname },
    });
  } catch (error) {
    next(error);
  }
};

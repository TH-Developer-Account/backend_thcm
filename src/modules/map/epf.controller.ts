import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

// Payload to be sent

// {
//   "epcId": "uuid",

//   "total_budget": 200000,
//   "expected_revenue": 300000,

//   "lineItems": [
//     {
//       "productId": "uuid",
//       "amount": 15000
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
//       "amount": 18000
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

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Update EPF fields
      const epf = await tx.ePF.update({
        where: { id: epfId as string },
        data: epfData,
      });

      // 2️⃣ Delete existing line items
      await tx.lineItem.deleteMany({
        where: { epfId: epfId as string },
      });

      // 3️⃣ Validate products exist (identity only — no rate lookup)
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 4️⃣ Recreate line items — amount comes straight from the proposer's
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
        };
      });

      await tx.lineItem.createMany({
        data: newItems,
      });

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

    res.status(200).json(epf);
  } catch (error) {
    next(error);
  }
};

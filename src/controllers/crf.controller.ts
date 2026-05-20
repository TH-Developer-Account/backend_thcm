import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// Payload to be sent

// {
//   "epcId": "uuid",
//   "lineItems": [
//     {
//       "productId": "uuid",
//       "quantity": 10
//     },
//     {
//       "productId": "uuid",
//       "quantity": 5
//     }
//   ]
// }

export const createCRF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId, lineItems } = req.body;

    if (!lineItems || lineItems.length === 0) {
      throw new ApiError(400, "Line items required");
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Validate EPC exists
      const proposal = await tx.eventProposal.findUnique({
        where: { id: epcId },
      });
      if (!proposal) throw new ApiError(404, "Event Proposal not found");

      // 2️⃣ Prevent duplicate CRF
      const existing = await tx.cRF.findUnique({ where: { epcId } });
      if (existing) throw new ApiError(400, "CRF already exists for this EPC");

      // 3️⃣ Create CRF
      const crf = await tx.cRF.create({
        data: { epcId },
      });

      // 4️⃣ Fetch products
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 5️⃣ Prepare line items
      const items = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);
        if (!product) throw new ApiError(400, "Invalid product");
        if (product.productType !== "CRF") {
          throw new ApiError(400, "Invalid product for CRF");
        }

        const rate = Number(product.unitRate);
        const quantity = Number(item.quantity);
        const amount = quantity * rate;

        return {
          crfId: crf.id,
          epfId: null,
          productId: product.id,
          quantity,
          rate,
          amount,
        };
      });

      // 6️⃣ Insert line items
      await tx.lineItem.createMany({ data: items });

      // 7️⃣ Log activity
      await tx.activityLog.create({
        data: {
          epcId,
          actorId: userId,
          action: "CRF_CREATED",
          workflowId: null,
          stageId: null,
          metadata: { reason: "CRF created." },
        },
      });

      return crf;
    });

    res.status(200).json({ message: "CRF created successfully", data: result });
  } catch (error) {
    next(error);
  }
};

// Payload to be sent

// {
//   "lineItems": [
//     {
//       "productId": "uuid",
//       "quantity": 20
//     }
//   ]
// }

export const updateCRF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { crfId } = req.params;
    const { lineItems } = req.body;

    if (!crfId) {
      throw new ApiError(
        404,
        "EPF Id is mandatory, Please send the correct EPF Id!",
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Ensure CRF exists
      const existing = await tx.cRF.findUnique({
        where: { id: crfId as string },
      });

      if (!existing) {
        throw new ApiError(400, "CRF not found");
      }

      // 2️⃣ Delete old items
      await tx.lineItem.deleteMany({
        where: { crfId: crfId as string },
      });

      // 3️⃣ Fetch products
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 4️⃣ Recreate line items
      const items = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);

        if (!product) throw new ApiError(400, "Invalid product");

        if (product.productType !== "CRF") {
          throw new ApiError(400, "Invalid product for CRF");
        }

        const rate = Number(product.unitRate);
        const quantity = Number(item.quantity);
        const amount = quantity * rate;

        return {
          crfId,
          epfId: null,
          productId: product.id,
          quantity,
          rate,
          amount,
        };
      });

      await tx.lineItem.createMany({
        data: items,
      });

      await tx.activityLog.create({
        data: {
          epcId: existing.epcId,
          actorId: req.user?.id as string,
          action: "CRF_UPDATED",
          workflowId: null,
          stageId: null,
          metadata: {
            reason: "CRF is Updated.",
          },
        },
      });

      return { id: crfId };
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const getCRFById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { crfId } = req.params;

    if (!crfId) {
      throw new ApiError(
        404,
        "EPF Id is mandatory, Please send the correct EPF Id!",
      );
    }

    const crf = await prisma.cRF.findUnique({
      where: { id: crfId as string },
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

    if (!crf) {
      throw new ApiError(404, "CRF not found");
    }

    res.status(200).json(crf);
  } catch (error) {
    next(error);
  }
};

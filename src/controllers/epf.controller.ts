import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// Payload to be sent

// {
//   "epcId": "uuid",

//   "total_budget": 200000,
//   "expected_revenue": 300000,

//   "lineItems": [
//     {
//       "productId": "uuid",
//       "quantity": 2
//     },
//     {
//       "productId": "uuid",
//       "quantity": 5
//     }
//   ]
// }

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

      // 2️⃣ Fetch product rates
      const products = await tx.productMaster.findMany({
        where: {
          id: {
            in: lineItems.map((i: Record<string, unknown>) => i.productId),
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // 3️⃣ Prepare line items
      const lineItemsData = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);

        if (!product) throw new ApiError(400, "Invalid product");

        const rate = Number(product.unitRate);
        const quantity = Number(item.quantity);
        const amount = quantity * rate;

        return {
          epfId: epf.id,
          crfId: null, // ✅ important
          productId: product.id,
          quantity,
          rate,
          amount,
        };
      });

      // 4️⃣ Insert line items
      await tx.lineItem.createMany({
        data: lineItemsData,
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
//       "quantity": 3
//     },
//     {
//       "productId": "uuid2",
//       "quantity": 10
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
      const newItems = lineItems.map((item: Record<string, string>) => {
        const product = productMap.get(item.productId);

        if (!product) throw new ApiError(400, "Invalid product");

        const quantity = Number(item.quantity);
        const rate = Number(product.unitRate);
        const amount = quantity * rate;

        return {
          epfId,
          crfId: null,
          productId: product.id,
          quantity,
          rate,
          amount,
        };
      });

      await tx.lineItem.createMany({
        data: newItems,
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

import { prisma } from "../config/prisma";
import { ProductType } from "../prisma/generated/prisma/client";
import { Request, Response, NextFunction } from "express";
import { handleCreate, handleUpdate } from "../helpers/masterData.helper";
import ApiError from "../utils/apiError";

const formatOptions = (data: any[], labelKey: string) => {
  return data.map((item) => ({
    value: item.id,
    label: item[labelKey],
  }));
};

const MODEL_MAP: Record<string, any> = {
  department: prisma.department,
  region: prisma.region,
  branch: prisma.branch,
  eventName: prisma.eventName,
  budgetMaster: prisma.budgetMaster,
};

export const getMasterData = async (req: Request, res: Response) => {
  try {
    const [
      departments,
      verticals,
      regions,
      branches,
      budgetMasters,
      eventNames,
    ] = await Promise.all([
      prisma.department.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          department_name: true,
        },
        // where: { status: "active" },
        orderBy: { department_name: "asc" },
      }),

      prisma.vertical.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          name: true,
          departmentId: true,
        },
        // where: { status: "active" },
        orderBy: { name: "asc" },
      }),

      prisma.region.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          region_name: true,
        },
        orderBy: { region_name: "asc" },
      }),

      prisma.branch.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          branch_name: true,
        },
        orderBy: { branch_name: "asc" },
      }),

      prisma.budgetMaster.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          code: true,
          fiscal_year: true,
          id_desc: true,
          value: true,
        },
      }),

      prisma.eventName.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          title: true,
        },
      }),
    ]);

    res.json({
      departments: formatOptions(departments, "department_name"),
      regions: formatOptions(regions, "region_name"),
      branches: formatOptions(branches, "branch_name"),
      eventNames: formatOptions(eventNames, "title"),
      budgetMasters: budgetMasters.map((b) => ({
        value: b.id,
        label: `${b.code}`,
        description: `${b.id_desc}`,
        budgetAmount: b.value,
      })),
      vertical: verticals.map((b) => ({
        value: b.id,
        label: `${b.name}`,
        department: b.departmentId,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch master data" });
  }
};

export const manageMasterData = async (req: Request, res: Response) => {
  try {
    const { type, action, data } = req.body;

    const model = MODEL_MAP[type];

    if (!model) throw new ApiError(400, "Invalid master data type");

    let result;

    switch (action) {
      case "create":
        result = await handleCreate(model, type, data);
        break;

      case "update":
        if (!data?.id) throw new ApiError(400, "ID is required for update");
        result = await handleUpdate(model, type, data);
        break;

      default:
        throw new ApiError(400, "Invalid action");
    }

    res.status(200).json({
      message: `Master data ${action} successful`,
      data: result,
    });
  } catch (error: any) {
    console.error("manageMasterData error:", error);
    res.status(500).json({
      message: "Failed to manage master data",
      error: error.message,
    });
  }
};

export const getProductsByType = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { productType } = req.query;

    if (!productType || typeof productType !== "string") {
      throw new ApiError(400, "productType is required");
    }

    const type = productType.toUpperCase() as keyof typeof ProductType;

    if (!ProductType[type]) {
      throw new ApiError(400, "Invalid productType");
    }

    const products = await prisma.productMaster.findMany({
      where: {
        productType: ProductType[type], // ensures EPF/CRF match
      },
      orderBy: {
        name: "asc",
      },
    });

    res.status(200).json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

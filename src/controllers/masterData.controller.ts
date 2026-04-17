import { prisma } from "../config/prisma";
import { Request, Response } from "express";
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
  eventScale: prisma.eventScale,
  eventName: prisma.eventName,
  budgetMaster: prisma.budgetMaster,
};

export const getMasterData = async (req: Request, res: Response) => {
  try {
    const [
      departments,
      regions,
      branches,
      eventScales,
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

      prisma.eventScale.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          title: true,
        },
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
      eventScales: formatOptions(eventScales, "title"),
      eventNames: formatOptions(eventNames, "title"),
      budgetMasters: budgetMasters.map((b) => ({
        value: b.id,
        label: `${b.id_desc} (${b.value})`,
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

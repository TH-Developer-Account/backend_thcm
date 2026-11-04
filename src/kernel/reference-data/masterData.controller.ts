// backend - controller
import axios from "axios";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { ProductType } from "../../prisma/generated/prisma/client";
import { Request, Response, NextFunction } from "express";
import { handleCreate, handleUpdate } from "./masterData.helper";

const formatOptions = <T>(
  data: T[],
  config: {
    label: (item: T) => string;
    value?: (item: T) => string;
    extra?: (item: T) => Record<string, any>;
  },
) => {
  return data.map((item) => ({
    value: config.value ? config.value(item) : (item as any).id,
    label: config.label(item),
    ...(config.extra ? config.extra(item) : {}),
  }));
};

// Note: "region" is intentionally absent here — Region was merged into Zone
// (same table; EventProposal's business region and User's zone are the same
// concept). The Masters admin UI only manages it under "zone" now; the
// `regions` key in getMasterData's response below stays only as a
// backward-compat bridge for other-module read consumers.
//
// "userRegion"/Locations is also absent — User.location went back to being
// plain free text (not a master-backed FK), so there's no Locations master
// screen or model to manage here anymore. See decisions-and-learnings.md.
const MODEL_MAP: Record<string, any> = {
  department: prisma.department,
  branch: prisma.branch,
  eventName: prisma.eventName,
  budgetMaster: prisma.budgetMaster,
  division: prisma.division,
  designation: prisma.designation,
  costCenter: prisma.costCenter,
  zone: prisma.zone,
};

export const getMasterData = async (req: Request, res: Response) => {
  try {
    const [
      departments,
      verticals,
      zones,
      branches,
      budgetMasters,
      eventNames,
      divisions,
      designations,
      costCenters,
    ] = await Promise.all([
      prisma.department.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          department_name: true,
          department_code: true,
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
          code: true,
        },
        // where: { status: "active" },
        orderBy: { name: "asc" },
      }),

      // One query backs both the `regions` and `zones` response keys below —
      // Region and Zone are the same table now (see schema.prisma's Zone
      // model comment), so there's no separate "region" query anymore.
      prisma.zone.findMany({
        where: { isActive: true },
        select: {
          id: true,
          region_name: true,
          region_code: true,
        },
        orderBy: { region_name: "asc" },
      }),

      prisma.branch.findMany({
        // where: { status: "active" },
        select: {
          id: true,
          branch_name: true,
          branch_code: true,
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

      prisma.division.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),

      prisma.designation.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),

      prisma.costCenter.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
    ]);

    const zoneOptions = formatOptions(zones, {
      label: (z) => z.region_name,
      extra: (z) => ({ code: z.region_code }),
    });

    res.json({
      departments: formatOptions(departments, {
        label: (d) => d.department_name,
        extra: (d) => ({ code: d.department_code }),
      }),
      // Bridge: other-module consumers (e.g. EPCTopbar) still read
      // `data.regions` — kept pointed at the same Zone data as `zones` below
      // rather than duplicating the query.
      regions: zoneOptions,
      branches: formatOptions(branches, {
        label: (b) => b.branch_name,
        extra: (b) => ({ code: b.branch_code }),
      }),
      eventNames: formatOptions(eventNames, {
        label: (e) => e.title,
      }),
      budgetMasters: budgetMasters.map((b) => ({
        value: b.id,
        label: `${b.code}`,
        description: `${b.id_desc}`,
        budgetAmount: b.value,
      })),
      vertical: verticals.map((b) => ({
        value: b.id,
        label: `${b.name}`,
        code: `${b.code}`,
        department: b.departmentId,
      })),
      divisions: formatOptions(divisions, {
        label: (d) => d.name,
      }),
      designations: formatOptions(designations, {
        label: (d) => d.name,
      }),
      costCenters: formatOptions(costCenters, {
        label: (c) => c.name,
        extra: (c) => ({ code: c.code }),
      }),
      zones: zoneOptions,
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

export const getBudgetOData = async (req: Request, res: Response) => {
  try {
    const response = await axios.get(
      "http://th-s4-qas-ad.tatahitachi.co.in:8001/sap/opu/odata/sap/ZBUDGET_API_SRV/ZSTR_BUDGET_APISet?$filter=BudgetCode%20eq%20%27P1SMN1380105%27&sap-client=635",
      {
        auth: {
          username: "d39351",
          password: "Publi@4321",
        },
        headers: {
          Accept: "application/json",
        },
      },
    );

    res.json(response.data);
  } catch (err: any) {
    throw new ApiError(500, "Unable to fetch the budget info from s4");
  }
};

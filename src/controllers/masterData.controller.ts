import { prisma } from "../config/prisma";
import { Request, Response } from "express";

const formatOptions = (data: any[], labelKey: string) => {
  return data.map((item) => ({
    value: item.id,
    label: item[labelKey],
  }));
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
        select: {
          id: true,
          department_name: true,
        },
        orderBy: { department_name: "asc" },
      }),

      prisma.region.findMany({
        select: {
          id: true,
          region_name: true,
        },
        orderBy: { region_name: "asc" },
      }),

      prisma.branch.findMany({
        select: {
          id: true,
          branch_name: true,
        },
        orderBy: { branch_name: "asc" },
      }),

      prisma.eventScale.findMany({
        select: {
          id: true,
          title: true,
        },
      }),

      prisma.budgetMaster.findMany({
        select: {
          id: true,
          code: true,
          fiscal_year: true,
          id_desc: true,
          value: true,
        },
      }),

      prisma.eventName.findMany({
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

import { prisma } from "../config/prisma";

type CreateTemplateInput = {
  name: string;
  workspaceId: string;
  regionId: string;
  minBudget: number;
  maxBudget: number;
  priority?: number;
  stages: {
    stageOrder: number;
    strategy: "ALL" | "ANY" | "QUORUM";
    minApprovals?: number;
    approverIds: string[];
  }[];
};

export const createWorkflowTemplate = async (input: CreateTemplateInput) => {
  return prisma.workflowTemplate.create({
    data: {
      name: input.name,
      workspaceId: input.workspaceId,
      regionId: input.regionId,
      minBudget: input.minBudget,
      maxBudget: input.maxBudget,
      priority: input.priority ?? 0,

      stages: {
        create: input.stages.map((stage) => ({
          stageOrder: stage.stageOrder,
          strategy: stage.strategy,
          minApprovals: stage.minApprovals,

          approvers: {
            create: stage.approverIds.map((userId) => ({
              userId,
            })),
          },
        })),
      },
    },
    include: {
      stages: {
        include: { approvers: true },
      },
    },
  });
};

export const updateTemplate = async (templateId: string, payload: any) => {
  const {
    name,
    regionId,
    minBudget,
    maxBudget,
    priority,
    isActive,
    stages, // full replacement expected
  } = payload;

  return prisma.$transaction(async (tx) => {
    // 1. Check template exists
    const existing = await tx.workflowTemplate.findUnique({
      where: { id: templateId },
      include: { workflowInstances: true },
    });

    if (!existing) throw new Error("Template not found");

    // 2. Prevent breaking active workflows
    const activeInstances = existing.workflowInstances.filter(
      (w) => w.status === "IN_PROGRESS",
    );

    if (activeInstances.length > 0) {
      throw new Error(
        "Cannot modify template with active workflows. Create new version instead.",
      );
    }

    // 3. Update basic fields
    await tx.workflowTemplate.update({
      where: { id: templateId },
      data: {
        name,
        regionId,
        minBudget,
        maxBudget,
        priority,
        isActive,
      },
    });

    if (!stages) return { message: "Template updated (no stage change)" };

    // 4. Delete existing stages (cascade deletes approvers)
    await tx.templateStage.deleteMany({
      where: { templateId },
    });

    // 5. Recreate stages
    for (const stage of stages) {
      const createdStage = await tx.templateStage.create({
        data: {
          templateId,
          stageOrder: stage.stageOrder,
          strategy: stage.strategy,
          minApprovals: stage.minApprovals,
        },
      });

      if (stage.approverIds?.length) {
        await tx.templateApprover.createMany({
          data: stage.approverIds.map((userId: string) => ({
            stageId: createdStage.id,
            userId,
          })),
        });
      }
    }

    return { message: "Template updated successfully" };
  });
};

export const deleteTemplate = async (templateId: string) => {
  return prisma.$transaction(async (tx) => {
    const template = await tx.workflowTemplate.findUnique({
      where: { id: templateId },
      include: { workflowInstances: true },
    });

    if (!template) throw new Error("Template not found");

    // 🚨 Critical Safety Check
    const hasRunningWorkflows = template.workflowInstances.some(
      (w) => w.status === "IN_PROGRESS",
    );

    if (hasRunningWorkflows) {
      throw new Error(
        "Cannot delete template with active workflows. Disable it instead.",
      );
    }

    // Optional: prevent delete if ANY historical workflows exist
    if (template.workflowInstances.length > 0) {
      throw new Error(
        "Template already used. Soft delete (isActive=false) recommended.",
      );
    }

    // Delete (cascade handles stages + approvers)
    await tx.workflowTemplate.delete({
      where: { id: templateId },
    });

    return { message: "Template deleted successfully" };
  });
};

export const getTemplates = async (filters: any) => {
  const { workspaceId, regionId, minBudget, maxBudget, isActive, page, limit } =
    filters;

  const where: any = {};

  if (workspaceId) where.workspaceId = workspaceId;
  if (regionId) where.regionId = regionId;
  if (isActive !== undefined) where.isActive = isActive === "true";

  if (minBudget || maxBudget) {
    where.AND = [];

    if (minBudget) {
      where.AND.push({
        maxBudget: { gte: Number(minBudget) },
      });
    }

    if (maxBudget) {
      where.AND.push({
        minBudget: { lte: Number(maxBudget) },
      });
    }
  }

  const [data, total] = await Promise.all([
    prisma.workflowTemplate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { priority: "desc" },

      include: {
        region: true,
        stages: {
          orderBy: { stageOrder: "asc" },
          include: {
            approvers: {
              include: {
                user: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
    }),

    prisma.workflowTemplate.count({ where }),
  ]);

  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const getTemplateById = async (templateId: string) => {
  const template = await prisma.workflowTemplate.findUnique({
    where: { id: templateId },

    include: {
      workspace: {
        select: { id: true, name: true },
      },
      region: {
        select: { id: true, region_name: true },
      },
      stages: {
        orderBy: { stageOrder: "asc" },
        include: {
          approvers: {
            include: {
              user: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!template) {
    throw new Error("Template not found");
  }

  return template;
};

export const selectTemplate = async ({
  workspaceId,
  regionId,
  budget,
}: {
  workspaceId: string;
  regionId: string;
  budget: number;
}) => {
  const templates = await prisma.workflowTemplate.findMany({
    where: {
      workspaceId,
      regionId,
      isActive: true,
      minBudget: { lte: budget },
      maxBudget: { gte: budget },
    },
    orderBy: {
      priority: "desc",
    },
    include: {
      stages: {
        include: {
          approvers: true,
        },
      },
    },
  });

  if (!templates.length) {
    throw new Error("No matching workflow template found");
  }

  return templates[0]; // highest priority
};

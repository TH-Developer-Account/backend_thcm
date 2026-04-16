import { prisma } from "../config/prisma";

type CreateTemplateInput = {
  name: string;
  description: string;
  workspaceId: string;
  metaData_1: string;
  metaData_2: string;
  metaData_3: string;
  appId: string;
  stages: {
    name: string;
    stageOrder: number;
    strategy: "ALL" | "ANY" | "SOME";
    minApprovals?: number;
    approverIds: string[];
  }[];
};

export const createWorkflowTemplate = async (
  input: CreateTemplateInput,
  userId: string,
) => {
  return prisma.workflowTemplate.create({
    data: {
      name: input.name,
      description: input.description,
      workspaceId: input.workspaceId,
      created_by_id: userId,
      updated_by_id: userId,
      appId: input.appId,
      metaData_1: input.metaData_1,
      metaData_2: input.metaData_2,
      metaData_3: input.metaData_3,

      stages: {
        create: input.stages.map((stage) => ({
          name: stage.name,
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
      app: true,
    },
  });
};

export const updateTemplate = async (
  templateId: string,
  payload: any,
  userId: string,
) => {
  const {
    name,
    metaData_1,
    metaData_2,
    metaData_3,
    isActive,
    stages, // full replacement expected
    appId,
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
        metaData_1,
        metaData_2,
        metaData_3,
        isActive,
        updated_by_id: userId,
        appId,
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
          name: stage.name,
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

export const getTemplates = async (query: any) => {
  const {
    workspaceId,
    isActive,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortOrder,
  } = query;

  const where: any = {};

  if (workspaceId) where.workspaceId = workspaceId;
  if (isActive !== undefined) where.isActive = isActive === "true";

  // ✅ Advanced Filters (NEW)
  if (filters) {
    const parsedFilters =
      typeof filters === "string" ? JSON.parse(filters) : filters;

    const { createdBy, apps } = parsedFilters;

    if (apps?.length) {
      where.appId = {
        in: Array.isArray(apps) ? apps : [apps], // fallback safety
      };
    }

    if (createdBy?.length) {
      where.created_by_id = {
        in: Array.isArray(createdBy) ? createdBy : [createdBy], // fallback safety
      };
    }
  }

  if (search?.trim()) {
    where.OR = [
      { name: { contains: search.trim(), mode: "insensitive" } },
      { description: { contains: search.trim(), mode: "insensitive" } },
    ];
  }

  // Whitelist allowed sort fields to prevent arbitrary column injection
  const allowedSortFields = [
    "created_at",
    "updated_at",
    "name",
    "minBudget",
    "maxBudget",
  ];
  const allowedSortOrders = ["asc", "desc"];

  const resolvedSortBy = allowedSortFields.includes(sortBy)
    ? sortBy
    : "created_at";
  const resolvedSortOrder = allowedSortOrders.includes(sortOrder)
    ? sortOrder
    : "desc";

  const [data, total] = await Promise.all([
    prisma.workflowTemplate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [resolvedSortBy]: resolvedSortOrder },
      include: {
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
        app: { select: { id: true, key: true, name: true } },
        created_by: { select: { first_name: true, last_name: true } },
        updated_by: { select: { first_name: true, last_name: true } },
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
}: {
  workspaceId: string;
}) => {
  const templates = await prisma.workflowTemplate.findMany({
    where: {
      workspaceId,
      isActive: true,
    },
    orderBy: {
      created_at: "desc",
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

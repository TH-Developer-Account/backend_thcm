import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import * as service from "../services/template.service";
import ApiError from "../utils/apiError";

// payload to be sent
// {
//   "name": "Standard EPC Approval",
//   "workspaceId": "workspace-uuid",
//   "regionId": "region-uuid",

//   "minBudget": 0,
//   "maxBudget": 1000000,

//   "priority": 1,
//   "isActive": true,

//   "stages": [
//     {
//       "stageOrder": 1,
//       "strategy": "ANY",
//       "approverIds": ["user-uuid-1", "user-uuid-2"]
//     },
//     {
//       "stageOrder": 2,
//       "strategy": "ALL",
//       "approverIds": ["user-uuid-3", "user-uuid-4"]
//     },
//     {
//       "stageOrder": 3,
//       "strategy": "QUORUM",
//       "minApprovals": 2,
//       "approverIds": ["user-uuid-5", "user-uuid-6", "user-uuid-7"]
//     }
//   ]
// }
export const createTemplateController = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    const template = await service.createWorkflowTemplate(req.body, userId);

    res.status(201).json({
      success: true,
      data: template,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// controllers/workflowTemplate.controller.ts

export const getTemplates = async (req: Request, res: Response) => {
  try {
    const {
      workspaceId,
      filters,
      search,
      isActive,
      page = 1,
      limit = 10,
      sortBy = "created_at",
      sortOrder = "desc",
    } = req.query;

    const result = await service.getTemplates({
      workspaceId,
      isActive,
      page: Number(page),
      limit: Number(limit),
      sortBy,
      sortOrder,
      filters,
      search,
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getTemplateById = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;

    const result = await service.getTemplateById(templateId as string);

    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
};

// Payload to be sent
// {
//   "name": "Updated EPC Flow",
//   "regionId": "region-uuid",
//   "minBudget": 0,
//   "maxBudget": 2000000,
//   "priority": 2,
//   "isActive": true,
//   "stages": [
//     {
//       "stageOrder": 1,
//       "strategy": "ANY",
//       "approverIds": ["user1", "user2"]
//     },
//     {
//       "stageOrder": 2,
//       "strategy": "ALL",
//       "approverIds": ["user3"]
//     }
//   ]
// }

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const payload = req.body;
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    const result = await service.updateTemplate(
      templateId as string,
      payload,
      userId,
    );

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;

    const result = await service.deleteTemplate(templateId as string);

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /workflow-templates/users
//
// Assigns users to a workflow template in one call.
//
// Payload:
// {
//   "templateId": "uuid",
//   "userIds":    ["uuid-1", "uuid-2", "uuid-3"]  ← send empty array to clear all
// }
// ─────────────────────────────────────────────────────────────────────────────

export async function assignUsersToWorkflow(req: Request, res: Response) {
  const { templateId, userIds } = req.body as {
    templateId: string;
    userIds: string[];
  };

  if (!templateId) {
    throw new ApiError(400, "templateId is required");
  }
  if (!Array.isArray(userIds)) {
    throw new ApiError(
      400,
      "userIds must be an array (send empty array to clear)",
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Validate template exists and get workspaceId from it
      const template = await tx.workflowTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, workspaceId: true },
      });
      if (!template) throw new ApiError(404, "Template not found");

      // Validate all userIds are workspace members in one query
      if (userIds.length > 0) {
        const members = await tx.workspaceUser.findMany({
          where: { workspaceId: template.workspaceId, userId: { in: userIds } },
          select: { userId: true },
        });

        if (members.length !== userIds.length) {
          const found = new Set(members.map((m) => m.userId));
          const missing = userIds.filter((id) => !found.has(id));
          throw new ApiError(
            404,
            `These users are not in the workspace: ${missing.join(", ")}`,
          );
        }
      }

      // Clear all current assignments for this template
      await tx.workFlowTemplateUser.deleteMany({ where: { templateId } });

      // Assign new users if array is not empty
      if (userIds.length > 0) {
        await tx.workFlowTemplateUser.createMany({
          data: userIds.map((userId) => ({ templateId, userId })),
        });
      }
    });

    // Fetch updated assignments to return in response
    let assignedUsers = null;

    if (userIds.length > 0) {
      assignedUsers = await prisma.workFlowTemplateUser.findMany({
        where: { templateId },
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
      });
    }

    const message =
      userIds.length > 0
        ? `${userIds.length} user(s) assigned to template successfully`
        : `All users cleared from template successfully`;

    res.status(200).json({ message, users: assignedUsers });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("assignUsersToTemplate failed:", error);
    res.status(500).json({
      message: "Failed to assign users to template",
      error: error.message,
    });
  }
}

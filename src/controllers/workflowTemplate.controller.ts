import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import * as service from "../services/template.service";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflow-templates
//
// Creates a new WorkflowTemplate with its stages and approvers.
//
// Expected payload:
// {
//   "name": "Standard EPC Approval",
//   "workspaceId": "workspace-uuid",
//   "appId": "app-uuid",
//   "metaData_1": "0-1000000",   ← budget range key (used by evaluateBudget)
//   "metaData_2": "",
//   "metaData_3": "",
//   "stages": [
//     { "stageOrder": 1, "strategy": "ANY",  "approverIds": ["u1", "u2"] },
//     { "stageOrder": 2, "strategy": "ALL",  "approverIds": ["u3"] },
//     { "stageOrder": 3, "strategy": "SOME", "minApprovals": 2, "approverIds": ["u4","u5","u6"] }
//   ]
// }
//
// No schema changes needed here — WorkflowTemplate itself is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const createTemplateController = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const template = await service.createWorkflowTemplate(req.body, userId);

    res.status(201).json({ success: true, data: template });
  } catch (err: any) {
    res.status(err instanceof ApiError ? err.statusCode : 500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflow-templates
//
// Paginated list of templates for a workspace.
// ─────────────────────────────────────────────────────────────────────────────

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

    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflow-templates/:templateId
// ─────────────────────────────────────────────────────────────────────────────

export const getTemplateById = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    if (!templateId) throw new ApiError(400, "templateId is required");

    const result = await service.getTemplateById(templateId as string);
    res.status(200).json({ success: true, data: result });
  } catch (err: any) {
    res
      .status(err instanceof ApiError ? err.statusCode : 404)
      .json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /workflow-templates/:templateId
//
// Updates a template's metadata, stages, and approvers.
//
// IMPORTANT: Editing a template does NOT retroactively affect WorkflowInstances
// that were already created from it. Runtime instances (StageInstance,
// Approval) snapshot the template at creation time, so live workflows are safe.
//
// Expected payload:
// {
//   "name": "Updated EPC Flow",
//   "metaData_1": "0-2000000",
//   "stages": [
//     { "stageOrder": 1, "strategy": "ANY",  "approverIds": ["u1","u2"] },
//     { "stageOrder": 2, "strategy": "ALL",  "approverIds": ["u3"] }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const payload = req.body;
    const userId = req?.user?.id;

    if (!templateId) throw new ApiError(400, "templateId is required");
    if (!userId) throw new ApiError(401, "Unauthorized");

    // Guard: warn if there are active IN_PROGRESS workflow instances using
    // this template. The update is still allowed (instances are independent)
    // but this helps surface potential confusion.
    const activeCount = await prisma.workflowInstance.count({
      where: {
        templateId: templateId as string,
        isActive: true,
        status: "IN_PROGRESS",
      },
    });

    const result = await service.updateTemplate(
      templateId as string,
      payload,
      userId,
    );

    res.status(200).json({
      success: true,
      data: result,
      ...(activeCount > 0 && {
        warning:
          `This template has ${activeCount} active IN_PROGRESS workflow(s). ` +
          "They are unaffected by this change (they snapshot the template at creation time), " +
          "but new workflows created from this template will use the updated configuration.",
      }),
    });
  } catch (err: any) {
    res
      .status(err instanceof ApiError ? err.statusCode : 400)
      .json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workflow-templates/:templateId
//
// Soft-deletes (deactivates) a template by setting isActive=false.
// Hard delete is blocked if any active WorkflowInstance references it,
// because the runtime stages need the template for the clarify re-run
// (it re-reads template.stages to create new StageInstances).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    if (!templateId) throw new ApiError(400, "templateId is required");

    // Block deletion if any active workflow still references this template.
    // The clarifyStageController re-reads template.stages to seed new stages,
    // so deleting the template would break any in-flight clarify flow.
    const activeWorkflowCount = await prisma.workflowInstance.count({
      where: {
        templateId: templateId as string,
        isActive: true,
        status: "IN_PROGRESS",
      },
    });

    if (activeWorkflowCount > 0) {
      throw new ApiError(
        409,
        `Cannot delete template: ${activeWorkflowCount} active workflow(s) are currently using it. ` +
          "Wait for them to complete or be superseded before deleting.",
      );
    }

    const result = await service.deleteTemplate(templateId as string);
    res.status(200).json({ success: true, data: result });
  } catch (err: any) {
    res
      .status(err instanceof ApiError ? err.statusCode : 400)
      .json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /workflow-templates/users
//
// Assigns (or clears) users who are allowed to manage workflows built from
// this template (i.e. who can call /workflows/assign and /workflows/deviation).
//
// Send an empty array to remove all users.
//
// Payload: { "templateId": "uuid", "userIds": ["uuid-1", "uuid-2"] }
// ─────────────────────────────────────────────────────────────────────────────

export async function assignUsersToWorkflow(req: Request, res: Response) {
  const { templateId, userIds } = req.body as {
    templateId: string;
    userIds: string[];
  };

  if (!templateId) throw new ApiError(400, "templateId is required");
  if (!Array.isArray(userIds)) {
    throw new ApiError(400, "userIds must be an array (send [] to clear all)");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, workspaceId: true },
      });
      if (!template) throw new ApiError(404, "Template not found");

      if (userIds.length > 0) {
        const members = await tx.workspaceUser.findMany({
          where: {
            workspaceId: template.workspaceId,
            userId: { in: userIds },
          },
          select: { userId: true },
        });

        if (members.length !== userIds.length) {
          const found = new Set(members.map((m) => m.userId));
          const missing = userIds.filter((id) => !found.has(id));
          throw new ApiError(
            404,
            `These users are not workspace members: ${missing.join(", ")}`,
          );
        }
      }

      // Replace all assignments atomically
      await tx.workFlowTemplateUser.deleteMany({ where: { templateId } });

      if (userIds.length > 0) {
        await tx.workFlowTemplateUser.createMany({
          data: userIds.map((userId) => ({ templateId, userId })),
        });
      }
    });

    const assignedUsers =
      userIds.length > 0
        ? await prisma.workFlowTemplateUser.findMany({
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
          })
        : null;

    const message =
      userIds.length > 0
        ? `${userIds.length} user(s) assigned to template successfully`
        : "All users cleared from template successfully";

    res.status(200).json({ success: true, message, users: assignedUsers });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    res.status(500).json({
      success: false,
      message: "Failed to assign users to template",
      error: error.message,
    });
  }
}

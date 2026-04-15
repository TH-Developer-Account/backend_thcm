import { Request, Response } from "express";
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
      regionId,
      minBudget,
      maxBudget,
      isActive,
      page = 1,
      limit = 10,
      sortBy = "created_at",
      sortOrder = "desc",
    } = req.query;

    const result = await service.getTemplates({
      workspaceId,
      regionId,
      minBudget,
      maxBudget,
      isActive,
      page: Number(page),
      limit: Number(limit),
      sortBy,
      sortOrder,
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

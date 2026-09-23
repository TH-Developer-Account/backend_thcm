import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import * as service from "./factoryAudit.services";

// ─────────────────────────────────────────────
// Templates (Admin)
// ─────────────────────────────────────────────

export const createFactoryAuditTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.createFactoryAuditTemplate(req.body);
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const listFactoryAuditTemplates = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { processCategory, isActive } = req.query;
    const templates = await service.listFactoryAuditTemplates({
      processCategory: processCategory as string | undefined,
      isActive: isActive === undefined ? undefined : isActive === "true",
    });
    res.status(200).json({ success: true, data: templates });
  } catch (error) {
    next(error);
  }
};

export const getFactoryAuditTemplateById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.getFactoryAuditTemplateById(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const updateFactoryAuditTemplateDraft = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.updateFactoryAuditTemplateDraft(
      req.params.id as string,
      req.body,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const createFactoryAuditTemplateDraftVersion = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.createFactoryAuditTemplateDraftVersion(
      req.params.id as string,
    );
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const publishFactoryAuditTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.publishFactoryAuditTemplate(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// Instance scheduling + listing (Admin)
// ─────────────────────────────────────────────

export const scheduleFactoryAuditInstance = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { vendorId, workspaceId, targetPartCategories, assignments } =
      req.body;
    if (!vendorId) throw new ApiError(400, "vendorId is required");
    if (!workspaceId) throw new ApiError(400, "workspaceId is required");

    const instance = await service.scheduleFactoryAuditInstance({
      vendorId,
      workspaceId,
      createdByUserId: userId,
      targetPartCategories: targetPartCategories ?? [],
      assignments: assignments ?? [],
    });
    res.status(201).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

export const listFactoryAuditInstances = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { vendorId } = req.query;
    const instances = await service.listFactoryAuditInstances({
      vendorId: vendorId as string | undefined,
    });
    res.status(200).json({ success: true, data: instances });
  } catch (error) {
    next(error);
  }
};

export const getFactoryAuditInstanceById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const instance = await service.getFactoryAuditInstanceById(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// Auditor surface — own assignment only
//
// Ownership itself is enforced inside the service (getOwnAssignmentOrThrow
// checks assignment.auditorId === the acting user), same pattern as Dealer
// Audit's "mine" routes — authorize() below only gates "does this user hold
// Factory Audit auditor access at all."
// ─────────────────────────────────────────────

export const saveFactoryAuditCheckpointScores = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const responses = await service.saveFactoryAuditCheckpointScores(
      userId,
      req.params.assignmentId as string,
      req.body.scores,
    );
    res.status(200).json({ success: true, data: responses });
  } catch (error) {
    next(error);
  }
};

export const submitFactoryAuditAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const result = await service.submitFactoryAuditAssignment(
      userId,
      req.params.assignmentId as string,
    );

    // Fires only once — the assignment that tips the round to
    // allSubmitted: true is, by definition, submitted exactly once.
    if (result.allSubmitted) {
      await service.notifyFactoryAuditAllSubmitted(result.auditInstanceId);
    }

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const reviseFactoryAuditCheckpointScore = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const response = await service.reviseFactoryAuditCheckpointScore(
      userId,
      req.params.assignmentId as string,
      req.body,
    );
    res.status(200).json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// Reviewer surface
// ─────────────────────────────────────────────

export const getFactoryAuditRoundProgress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const progress = await service.getFactoryAuditRoundProgress(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: progress });
  } catch (error) {
    next(error);
  }
};

export const getFactoryAuditRoundScoreComparison = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const comparison = await service.getFactoryAuditRoundScoreComparison(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: comparison });
  } catch (error) {
    next(error);
  }
};

export const finalizeFactoryAuditRoundScoring = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const results = await service.finalizeFactoryAuditRoundScoring(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
};

export const submitFactoryAuditForApproval = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const result = await service.submitFactoryAuditForApproval(
      req.params.id as string,
      userId,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const flagFactoryAuditCheckpointForImprovement = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const { remark } = req.body;
    if (!remark)
      throw new ApiError(400, "remark is required when flagging a checkpoint");
    const result = await service.flagFactoryAuditCheckpointForImprovement(
      req.params.id as string,
      req.params.checkpointId as string,
      userId,
      remark,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const unflagFactoryAuditCheckpoint = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await service.unflagFactoryAuditCheckpoint(
      req.params.id as string,
      req.params.checkpointId as string,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const reopenFactoryAuditInstance = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const instance = await service.reopenFactoryAuditInstance(
      req.params.id as string,
      userId,
    );
    res.status(201).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

export const createFactoryAuditSubAudit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const instance = await service.createFactoryAuditSubAudit(
      req.params.id as string,
      userId,
    );
    res.status(201).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

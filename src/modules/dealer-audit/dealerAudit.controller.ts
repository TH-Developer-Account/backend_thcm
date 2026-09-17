import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import * as service from "./dealerAudit.service";
import { BusinessPartnerOfficeType } from "../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────
// Templates (Admin)
// ─────────────────────────────────────────────

export const createChecklistTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.createChecklistTemplate(req.body);
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const listChecklistTemplates = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { officeType, isActive } = req.query;
    const templates = await service.listChecklistTemplates({
      officeType: officeType as BusinessPartnerOfficeType,
      isActive: isActive === undefined ? undefined : isActive === "true",
    });
    res.status(200).json({ success: true, data: templates });
  } catch (error) {
    next(error);
  }
};

export const getChecklistTemplateById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.getChecklistTemplateById(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const updateChecklistTemplateDraft = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.updateChecklistTemplateDraft(
      req.params.id as string,
      req.body,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const createTemplateDraftVersion = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.createTemplateDraftVersion(
      req.params.id as string,
    );
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

export const publishChecklistTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const template = await service.publishChecklistTemplate(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// Internal staff surface
// ─────────────────────────────────────────────

export const triggerDealerAuditInstance = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { dealerUserId, periodLabel } = req.body;
    if (!dealerUserId) throw new ApiError(400, "dealerUserId is required");
    const instance = await service.triggerDealerAuditInstance(
      dealerUserId,
      periodLabel,
    );
    res.status(201).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

export const listDealerAuditInstances = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { officeType, periodLabel, dealerUserId } = req.query;
    const instances = await service.listDealerAuditInstances({
      officeType: officeType as BusinessPartnerOfficeType,
      periodLabel: periodLabel as string | undefined,
      dealerUserId: dealerUserId as string | undefined,
    });
    res.status(200).json({ success: true, data: instances });
  } catch (error) {
    next(error);
  }
};

export const getDealerAuditInstanceById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const instance = await service.getDealerAuditInstanceById(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

export const setDealerAuditReviewerNotes = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    await service.setDealerAuditReviewerNotes(
      userId,
      req.params.id as string,
      req.body.responses,
    );
    res.status(200).json({ success: true, message: "Reviewer notes updated" });
  } catch (error) {
    next(error);
  }
};

export const setDealerAuditReviewStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    await service.setDealerAuditReviewStatus(
      userId,
      req.params.id as string,
      req.body.responses,
    );
    res.status(200).json({ success: true, message: "Review status updated" });
  } catch (error) {
    next(error);
  }
};

export const generateAndSendDealerAuditReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const result = await service.generateAndSendDealerAuditReport(
      userId,
      req.params.id as string,
      { ccReviewer: req.body?.ccReviewer },
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// Dealer surface
// ─────────────────────────────────────────────

export const listMyDealerAuditInstances = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const instances = await service.listMyDealerAuditInstances(userId);
    res.status(200).json({ success: true, data: instances });
  } catch (error) {
    next(error);
  }
};

export const getMyDealerAuditInstanceById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const instance = await service.getMyDealerAuditInstanceById(
      userId,
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: instance });
  } catch (error) {
    next(error);
  }
};

export const saveMyDealerAuditResponses = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    await service.saveMyDealerAuditResponses(
      userId,
      req.params.id as string,
      req.body.responses,
    );
    res.status(200).json({ success: true, message: "Responses saved" });
  } catch (error) {
    next(error);
  }
};

export const submitMyDealerAuditInstance = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const workflowInstance = await service.submitMyDealerAuditInstance(
      userId,
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: workflowInstance });
  } catch (error) {
    next(error);
  }
};

export const resubmitMyDealerAuditInstance = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    await service.resubmitMyDealerAuditInstance(
      userId,
      req.params.id as string,
      req.body.responses,
    );
    res.status(200).json({ success: true, message: "Resubmitted" });
  } catch (error) {
    next(error);
  }
};

export const uploadMyDealerAuditItemEvidence = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");
    const { geoLat, geoLng } = req.body;
    const evidence = await service.uploadMyDealerAuditItemEvidence(
      userId,
      req.params.id as string,
      req.params.itemId as string,
      req.files as Express.Multer.File[],
      {
        geoLat: geoLat !== undefined ? Number(geoLat) : undefined,
        geoLng: geoLng !== undefined ? Number(geoLng) : undefined,
      },
    );
    res.status(201).json({ success: true, data: evidence });
  } catch (error) {
    next(error);
  }
};

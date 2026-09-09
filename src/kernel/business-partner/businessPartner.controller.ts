import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import { BusinessPartnerOfficeType } from "../../prisma/generated/prisma/client";
import * as businessPartnerService from "./businessPartner.services";

// All handlers here just call the service and hand any error to next(err) —
// status-code mapping (ApiError.statusCode -> HTTP response) already lives
// once, centrally, in error.middleware.ts. No reason to repeat it per handler.

// -----------------------------------------------------------------------------
// POST /business-partners
// -----------------------------------------------------------------------------

export const createBusinessPartner = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { officeType, bpType } = req.body;

    if (!officeType || !(officeType in BusinessPartnerOfficeType)) {
      throw new ApiError(
        400,
        "A valid officeType (HEAD_OFFICE | BRANCH_OFFICE) is required",
      );
    }
    if (!bpType) {
      throw new ApiError(
        400,
        "A valid bpType (DEALER | CUSTOMER | THCM) is required",
      );
    }

    const businessPartner = await businessPartnerService.createBusinessPartner(
      req.body,
    );
    res.status(201).json({ success: true, data: businessPartner });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partners/:id
// -----------------------------------------------------------------------------

export const getBusinessPartnerById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const businessPartner = await businessPartnerService.getBusinessPartnerById(
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: businessPartner });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partners
//
// Query params: search, officeType, bpType, isActive, parentId, page, limit
// -----------------------------------------------------------------------------

export const listBusinessPartners = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { search, officeType, bpType, isActive, parentId, page, limit } =
      req.query;

    const result = await businessPartnerService.listBusinessPartners({
      search: search as string | undefined,
      officeType: officeType as BusinessPartnerOfficeType | undefined,
      bpType: bpType as string | undefined,
      isActive: isActive === undefined ? undefined : isActive === "true",
      parentId:
        parentId === undefined ? undefined : (parentId as string) || null,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// PATCH /business-partners/:id
// -----------------------------------------------------------------------------

export const updateBusinessPartner = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const businessPartner = await businessPartnerService.updateBusinessPartner(
      req.params.id as string,
      req.body,
    );
    res.status(200).json({ success: true, data: businessPartner });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// DELETE /business-partners/:id  (soft delete: isActive = false)
// -----------------------------------------------------------------------------

export const deactivateBusinessPartner = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const businessPartner =
      await businessPartnerService.deactivateBusinessPartner(
        req.params.id as string,
      );
    res.status(200).json({ success: true, data: businessPartner });
  } catch (err) {
    next(err);
  }
};

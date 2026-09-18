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

// -----------------------------------------------------------------------------
// POST /business-partner/:businessPartnerId/contacts
// -----------------------------------------------------------------------------

export const createBusinessPartnerContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!req.body.name?.trim()) {
      throw new ApiError(400, "name is required");
    }

    const contact = await businessPartnerService.createBusinessPartnerContact(
      req.params.businessPartnerId as string,
      req.body,
    );
    res.status(201).json({ success: true, data: contact });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partner/:businessPartnerId/contacts
// -----------------------------------------------------------------------------

export const listBusinessPartnerContacts = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const contacts = await businessPartnerService.listBusinessPartnerContacts(
      req.params.businessPartnerId as string,
    );
    res.status(200).json({ success: true, data: contacts });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partner/:businessPartnerId/contacts/:id
// -----------------------------------------------------------------------------

export const getBusinessPartnerContactById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const contact = await businessPartnerService.getBusinessPartnerContactById(
      req.params.businessPartnerId as string,
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: contact });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// PATCH /business-partner/:businessPartnerId/contacts/:id
// -----------------------------------------------------------------------------

export const updateBusinessPartnerContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const contact = await businessPartnerService.updateBusinessPartnerContact(
      req.params.businessPartnerId as string,
      req.params.id as string,
      req.body,
    );
    res.status(200).json({ success: true, data: contact });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// DELETE /business-partner/:businessPartnerId/contacts/:id
// -----------------------------------------------------------------------------

export const deleteBusinessPartnerContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    await businessPartnerService.deleteBusinessPartnerContact(
      req.params.businessPartnerId as string,
      req.params.id as string,
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// POST /business-partner/:businessPartnerId/addresses
// -----------------------------------------------------------------------------

export const createBusinessPartnerAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const address = await businessPartnerService.createBusinessPartnerAddress(
      req.params.businessPartnerId as string,
      req.body,
    );
    res.status(201).json({ success: true, data: address });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partner/:businessPartnerId/addresses
// -----------------------------------------------------------------------------

export const listBusinessPartnerAddresses = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const addresses = await businessPartnerService.listBusinessPartnerAddresses(
      req.params.businessPartnerId as string,
    );
    res.status(200).json({ success: true, data: addresses });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// GET /business-partner/:businessPartnerId/addresses/:id
// -----------------------------------------------------------------------------

export const getBusinessPartnerAddressById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const address = await businessPartnerService.getBusinessPartnerAddressById(
      req.params.businessPartnerId as string,
      req.params.id as string,
    );
    res.status(200).json({ success: true, data: address });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// PATCH /business-partner/:businessPartnerId/addresses/:id
// -----------------------------------------------------------------------------

export const updateBusinessPartnerAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const address = await businessPartnerService.updateBusinessPartnerAddress(
      req.params.businessPartnerId as string,
      req.params.id as string,
      req.body,
    );
    res.status(200).json({ success: true, data: address });
  } catch (err) {
    next(err);
  }
};

// -----------------------------------------------------------------------------
// DELETE /business-partner/:businessPartnerId/addresses/:id
// -----------------------------------------------------------------------------

export const deleteBusinessPartnerAddress = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    await businessPartnerService.deleteBusinessPartnerAddress(
      req.params.businessPartnerId as string,
      req.params.id as string,
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

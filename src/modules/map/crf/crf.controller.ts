import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  createCrf,
  getCrfDetail,
  replaceCrfItems,
  type CrfItemInput,
} from "@modules/map/crf/services/crf.services";

/**
 * modules/map/crf.controller.ts
 *
 * Thin request/response adapter over crf.service.ts. All ownership/status
 * rules, the catalog-vs-souvenir item validation, and the ActivityLog
 * writes live there now (see crf.service.ts's own header comment) — this
 * file only extracts the request, calls the matching service function, and
 * shapes the response as { success, data } so the frontend's crf.api.ts
 * (which always destructures `{ data: { data } }`) reads it the same way
 * on create, update and get.
 */

type Actor = AccessActor & { id: string };

const requireActor = (req: Request): Actor => {
  const actor = req.user as Actor | undefined;
  if (!actor?.id) throw new ApiError(401, "Unauthorized");
  return actor;
};

// POST /crf
// Body: { epcId: string, items: CrfItemInput[] }
export const createCRF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { epcId, items } = req.body as {
      epcId?: string;
      items?: CrfItemInput[];
    };

    if (!epcId) throw new ApiError(400, "epcId is required");

    const crf = await createCrf(actor, epcId, items ?? []);
    res.status(200).json({ success: true, data: crf });
  } catch (error) {
    next(error);
  }
};

// PUT /crf/:crfId — full replace of the CRF's line items.
// Body: { items: CrfItemInput[] }
export const updateCRF = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    const { items } = req.body as { items?: CrfItemInput[] };

    if (!crfId) throw new ApiError(400, "crfId is required");

    const result = await replaceCrfItems(actor, crfId as string, items ?? []);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /crf/:crfId
export const getCRFById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;

    if (!crfId) throw new ApiError(400, "crfId is required");

    const crf = await getCrfDetail(actor, crfId as string);
    res.status(200).json({ success: true, data: crf });
  } catch (error) {
    next(error);
  }
};

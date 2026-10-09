import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  updateDispatchDetails,
  type DispatchDetailsInput,
} from "@map/crf/services/crfDispatch.services";
import {
  cancelOrder,
  placeOrder,
  retryOrder,
  swapSouvenirLines,
} from "@map/crf/services/crfOrder.services";
import type { ShopifyCrfItemInput } from "@map/crf/services/crf.services";

/**
 * modules/map/crf-order.controller.ts
 *
 * Thin request/response adapter over crfDispatchDetails.service.ts and
 * crfOrder.service.ts — the post-approval half of a CRF's lifecycle
 * (dispatch details, souvenir swap on shortfall, placing/retrying/
 * cancelling the Shopify order). Same shape convention as crf.controller.ts:
 * every response is { success: true, data }, and every ownership/status
 * rule lives in the service layer, not here.
 *
 * There is deliberately no "get order" handler here — GET /crf/:crfId
 * (crf.controller.ts → crf.service.ts's getCrfDetail) already returns
 * `order` and `permissions` on every CRF fetch, so the frontend re-fetches
 * the CRF after any of these mutations rather than this file growing a
 * second read path for the same data.
 */

type Actor = AccessActor & { id: string };

const requireActor = (req: Request): Actor => {
  const actor = req.user as Actor | undefined;
  if (!actor?.id) throw new ApiError(401, "Unauthorized");
  return actor;
};

// PUT /crf/:crfId/dispatch-details
export const putCrfDispatchDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    if (!crfId) throw new ApiError(400, "crfId is required");

    const crf = await updateDispatchDetails(
      actor,
      crfId as string,
      req.body as DispatchDetailsInput,
    );
    res.status(200).json({ success: true, data: crf });
  } catch (error) {
    next(error);
  }
};

// PUT /crf/:crfId/souvenirs — full replace of the souvenir lines only,
// while the CRF is STOCK_SHORTFALL. Catalog (printed material / artwork)
// lines are untouched — that's the separate full-replace on PUT /crf/:crfId
// in crf.controller.ts, which is only allowed while the CRF is OPEN.
export const putCrfSouvenirs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    const { items } = req.body as { items?: ShopifyCrfItemInput[] };
    if (!crfId) throw new ApiError(400, "crfId is required");

    const result = await swapSouvenirLines(actor, crfId as string, items ?? []);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /crf/:crfId/order
// Body: { acceptPartial?: boolean } — true only when the CRF is
// STOCK_SHORTFALL and the proposer is accepting the shortfall as a debit
// note instead of swapping lines.
export const postCrfOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    const { acceptPartial } = req.body as { acceptPartial?: boolean };
    if (!crfId) throw new ApiError(400, "crfId is required");

    const order = await placeOrder(actor, crfId as string, { acceptPartial });
    res.status(200).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /crf/:crfId/order/retry — ORDER_FAILED only, always a full retry.
export const postCrfOrderRetry = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    if (!crfId) throw new ApiError(400, "crfId is required");

    const order = await retryOrder(actor, crfId as string);
    res.status(200).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /crf/:crfId/order/cancel
// Body: { reason?: string }
export const postCrfOrderCancel = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { crfId } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!crfId) throw new ApiError(400, "crfId is required");

    const result = await cancelOrder(actor, crfId as string, reason);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

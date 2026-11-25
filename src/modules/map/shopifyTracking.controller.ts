// modules/map/shopifyTracking.controller.ts
//
// POST /crf/order/tracking — the Shopify/THCM-side tracking callback.
// shopifyAuth-guarded (no requireAuth, no req.user — there is no MAP actor
// behind this request), mounted directly in app.ts ahead of the normal
// requireAuth chain, same as before.
//
// This file replaces crf-order.controller.ts's postShopifyOrderTracking.
// It now serves two domains (CRF and Handouts), so it lives at the neutral
// modules/map/ level rather than under crf/ — a CRF-named file importing a
// Handouts service would be the wrong way round. It is a thin dispatcher
// only: `channel` (the same value each domain already sends outbound on
// Create Order — CRF: "MAP", Handouts: "HANDOUT") picks which domain's own
// service handles the call. Each branch keeps its own field validation and
// calls into its own, otherwise-untouched service function — CRF's
// recordShopifyTracking (crfOrder.services.ts) is unchanged by this file.
import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";
import { recordShopifyTracking } from "@map/crf/services/crfOrder.services";
// NOTE: I'm not sure of the real path alias for the Handouts backend module
// — every import inside handoutsDecision.services.ts/handouts.services.ts
// is relative (./handoutStatus.constants etc.), so there's no existing
// cross-module import of it to copy the alias from. Adjust this to whatever
// your tsconfig actually maps the Handouts module to.
import { recordHandoutShopifyTracking } from "@modules/handouts/handoutsTracking.services";

export type ShopifyTrackingChannel = "MAP" | "HANDOUT";

export type ShopifyTrackingWebhookPayload = {
  orderId: string;
  epcId?: string;
  trackingId?: string;
  trackingUrl?: string;
  channel: ShopifyTrackingChannel;
  isShipping: boolean;
};

// ── MAP (CRF) branch — same whitelist/validation postShopifyOrderTracking
// always did, just relocated. trackingId/trackingUrl stay required: CRF
// orders are always shipped (isShipping is expected true here).
const handleCrfTracking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { orderId, epcId, trackingId, trackingUrl } =
      req.body as ShopifyTrackingWebhookPayload;

    const missing = (
      [
        ["orderId", orderId],
        ["epcId", epcId],
        ["trackingId", trackingId],
        ["trackingUrl", trackingUrl],
      ] as const
    )
      .filter(([, value]) => typeof value !== "string" || !value.trim())
      .map(([field]) => field);

    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Missing or invalid field(s): ${missing.join(", ")}`,
      );
    }

    const result = await recordShopifyTracking({
      orderId: (orderId as string).trim(),
      epcId: (epcId as string).trim(),
      trackingId: (trackingId as string).trim(),
      trackingUrl: (trackingUrl as string).trim(),
    });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ── HANDOUT branch — trackingId/trackingUrl are only required when
// isShipping is true (HAND_DELIVERY handouts have nothing to track; see
// handoutsTracking.services.ts's recordHandoutShopifyTracking).
const handleHandoutTracking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { orderId, isShipping, trackingId, trackingUrl } =
      req.body as ShopifyTrackingWebhookPayload;

    if (typeof orderId !== "string" || !orderId.trim()) {
      throw new ApiError(400, "Missing or invalid field: orderId");
    }
    if (typeof isShipping !== "boolean") {
      throw new ApiError(400, "Missing or invalid field: isShipping");
    }

    const result = await recordHandoutShopifyTracking({
      orderId: orderId.trim(),
      isShipping,
      trackingId: trackingId?.trim(),
      trackingUrl: trackingUrl?.trim(),
    });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const postShopifyOrderTracking = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { channel } = req.body as ShopifyTrackingWebhookPayload;
  switch (channel) {
    case "MAP":
      return handleCrfTracking(req, res, next);
    case "HANDOUT":
      return handleHandoutTracking(req, res, next);
    default:
      return next(new ApiError(400, `Unknown channel: ${channel}`));
  }
};

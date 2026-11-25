// handouts/handoutsTracking.services.ts
//
// Inbound half of Handouts' Shopify order tracking — the HANDOUT branch of
// the shared /crf/order/tracking webhook (see modules/map/shopifyTracking.
// controller.ts for the dispatch-by-channel). Mirrors crfOrder.services.ts's
// recordShopifyTracking: same reliable-key lookup (shopifyOrderId, @unique),
// same "no MAP actor behind this call" posture (actorId: null on the
// ActivityLog row).
//
// Deliberately does NOT touch HandoutRequest.status. Closing a request
// (CLOSED) only ever happens through the existing manual deliver() flow in
// handoutsDecision.services.ts — this webhook's job is limited to surfacing
// tracking info ahead of that, never to replace the delivery team's own
// "Request fulfilled" action, Shopify/courier fulfillment signal or not.

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import logger from "@shared/utils/logger";
import { safeNotifyHandoutEvent } from "./handoutsNotify.helper";

export type HandoutShopifyTrackingInput = {
  orderId: string;
  isShipping: boolean;
  trackingId?: string;
  trackingUrl?: string;
};

export async function recordHandoutShopifyTracking(
  input: HandoutShopifyTrackingInput,
): Promise<{ id: string }> {
  const handoutOrder = await prisma.handoutOrder.findUnique({
    where: { shopifyOrderId: input.orderId },
  });

  if (!handoutOrder) {
    throw new ApiError(
      404,
      `No Handout order found for Shopify order ${input.orderId}`,
    );
  }

  // HAND_DELIVERY — Shopify/THCM has nothing to track (no courier involved).
  // Informational only: nothing to persist, nothing new for the FE to show.
  if (!input.isShipping) {
    logger.info(
      `[handoutsTracking.service] Hand-carry confirmation for Shopify order ${input.orderId} — no tracking data to store`,
    );
    return { id: handoutOrder.handoutId };
  }

  if (!input.trackingId?.trim() || !input.trackingUrl?.trim()) {
    throw new ApiError(
      400,
      "trackingId and trackingUrl are required when isShipping is true",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.handoutOrder.update({
      where: { shopifyOrderId: input.orderId },
      data: {
        trackingNumber: input.trackingId,
        trackingUrl: input.trackingUrl,
        trackingUpdatedAt: new Date(),
      },
    });

    await tx.activityLog.create({
      data: {
        subjectType: "HANDOUT_REQUEST",
        subjectId: handoutOrder.handoutId,
        actorId: null,
        action: "HANDOUT_ORDER_TRACKING_UPDATED",
        workflowId: null,
        stageId: null,
        metadata: {
          shopifyOrderId: input.orderId,
          trackingId: input.trackingId,
          trackingUrl: input.trackingUrl,
        },
      },
    });
  });

  // Strictly after the transaction has committed — same rule crfOrder.
  // services.ts's recordShopifyTracking follows for its own notification.
  await safeNotifyHandoutEvent({
    handoutId: handoutOrder.handoutId,
    event: "TRACKING_UPDATED",
    trackingId: input.trackingId,
    trackingUrl: input.trackingUrl,
  });

  return { id: handoutOrder.handoutId };
}

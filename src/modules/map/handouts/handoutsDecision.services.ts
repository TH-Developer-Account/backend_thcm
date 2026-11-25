// handouts/handoutsDecision.services.ts
//
// Status-transition actions: approve, reject, clarify, cancel, cannot-fulfil
// (manual), deliver.
//
// ✅ CHANGED — approve/reject now delegate the actual state transition to
// the generic kernel/workflow engine (approveStage/rejectStage) instead of
// hand-rolling it, now that Handouts has a real WorkflowInstance behind it
// (see handouts.services.ts's createHandout and handoutsAccess.helper.ts).
// clarify/cancel/cannot-fulfil/deliver are UNCHANGED — none of them has a
// generic-engine equivalent (the kernel models approve/reject, not "send
// back for clarification" as a single-stage no-iteration operation, and
// has no concept of "delivery" at all), so they stay exactly the
// Handout-specific side channel they always were, never touching the
// WorkflowInstance. That boundary is deliberate, not a gap: see the chat
// history for why clarify/resubmit weren't moved onto
// clarifyStageController/activateFirstStageController (that logic lives in
// workflow.controller.ts as request/response-coupled controller code, not
// as a reusable service function, and Handouts' single fixed stage never
// needs the iteration-editing it exists for).

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
// Per project convention, import another module's integration only through
// its barrel (index.ts), never thcmShop.client directly.
import { thcmShopClient } from "@modules/map/crf/shopify";
// NOTE: same path-alias uncertainty as shopifyTracking.controller.ts flagged
// for its own cross-module import — every other import in this file is
// relative, so there's nothing existing to copy the alias from. Adjust to
// whatever your tsconfig actually maps kernel/workflow to.
import { approveStage, rejectStage } from "@kernel/workflow/workflow.service";
import {
  HANDOUT_STATUS,
  HANDOUT_FULFILLMENT_TYPE,
  HANDOUT_PLACEHOLDER_PICKUP_ADDRESS,
  assertValidHandoutTransition,
} from "./handoutStatus.constants";
import {
  getHandoutAccess,
  assertHandoutAccess,
  type Actor,
} from "./handoutsAccess.helper";
import { getHandoutDetail } from "./handouts.services";
import { safeNotifyHandoutEvent } from "./handoutsNotify.helper";

// ActivityLog is written directly via prisma.activityLog.create — same as
// every call site in crfOrder.services.ts. No logActivity() wrapper exists
// in this codebase. workflowId/stageId are null on the entries this file
// still writes itself (clarify/cancel/cannot-fulfil/deliver, and reject's
// supplementary entry below) — approveStage/rejectStage write their own
// entries, with real workflowId/stageId, for the transitions they now own.

const requireReason = (reason: string | undefined, action: string): string => {
  if (!reason?.trim())
    throw new ApiError(400, `A reason is required to ${action}`);
  return reason.trim();
};

// ── Shared: build and place the Shopify order ───────────────────────────────
// Called from runHandoutFinalApprovalHook below, once the generic engine's
// approveStage has committed the handout to APPROVED. Builds the
// shippingAddress from either the real SHIPPED address on the request, or
// the fixed HAND_DELIVERY placeholder — Shopify's createOrder always needs
// *some* address, it has no notion of "pick up in person".
//
// NOTE: double-check the field names in this payload (referenceNumber,
// lineItems, etc.) against ThcmCreateOrderRequest in thcmShop.ts before
// relying on this — I reconstructed this from the CRF usage pattern rather
// than re-reading the exact Handouts-side wire type.
const executeHandoutOrderPlacement = async (handoutId: string) => {
  const handout = await prisma.handoutRequest.findUniqueOrThrow({
    where: { id: handoutId },
    include: {
      items: true,
      requestedBy: {
        select: { first_name: true, last_name: true, email: true },
      },
    },
  });
  const requesterName =
    `${handout.requestedBy.first_name} ${handout.requestedBy.last_name}`.trim();

  // ThcmCreateOrderRequest.email is required, but Handouts only ever
  // collects contactPhone, not email — User.email is nullable in your
  // schema. Failing loudly here (409, fixable by the requester updating
  // their profile) beats silently sending an empty string Shopify would
  // likely reject anyway with a less actionable error.
  if (!handout.requestedBy.email) {
    throw new ApiError(
      409,
      "The requester's profile has no email on file — required to place the Shopify order. Add an email to the requester's profile and retry.",
    );
  }

  // Address columns are addressLine1/Line2/Landmark/City/District/State/
  // Pincode/Country/Gstin on HandoutRequest — the same set CRF uses.
  const shippingAddress =
    handout.fulfillmentType === HANDOUT_FULFILLMENT_TYPE.SHIPPED
      ? {
          address1: handout.addressLine1 ?? "",
          address2: handout.addressLine2 ?? undefined,
          city: handout.addressCity ?? "",
          province: handout.addressState ?? "",
          zip: handout.addressPincode ?? "",
          country: handout.addressCountry ?? "India",
          phone: handout.contactPhone,
        }
      : { ...HANDOUT_PLACEHOLDER_PICKUP_ADDRESS, phone: handout.contactPhone };

  // Same ThcmCreateOrderRequest / response shape crfOrder.services.ts's
  // executeOrderPlacement uses: items/name/phone/shippingAddress in,
  // { shopifyOrderId, totalPrice, lineItems: [{sku,title,quantity,price}] }
  // out.
  const order = await thcmShopClient.createOrder({
    items: handout.items.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
    })),
    name: requesterName,
    email: handout.requestedBy.email,
    phone: handout.contactPhone,
    channel: "MAP",
    // SHIPPED handouts are a real courier shipment (tracking will follow via
    // the webhook); HAND_DELIVERY has nothing for THCM/Shopify to ship or
    // track, so isShipping is false — see ThcmCreateOrderRequest.isShipping
    // in modules/map/crf/shopify/thcmShop.ts.
    isShipping: handout.fulfillmentType === HANDOUT_FULFILLMENT_TYPE.SHIPPED,
    shippingAddress,
  });

  // HandoutOrder only holds the Shopify order snapshot — shopifyOrderId/
  // totalPrice/lines (Json), same shape as CrfOrder.lines. No status or
  // delivery fields on this model; those live on HandoutRequest itself.
  await prisma.handoutOrder.create({
    data: {
      handoutId,
      shopifyOrderId: order.shopifyOrderId,
      totalPrice: Number(order.totalPrice),
      lines: order.lineItems.map((line) => ({
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        unitPrice: line.price,
        lineTotal: (Number(line.price) * line.quantity).toFixed(2),
      })),
    },
  });

  return order;
};

// ─────────────────────────────────────────────────────────────────────────────
// runHandoutFinalApprovalHook  ✅ NEW
//
// Wired into kernel/workflow/workflowSubject.helper.ts's
// postFinalApprovalHooks.HANDOUT_REQUEST — called by the generic engine's
// approveStage strictly AFTER its own transaction (which already flipped
// HandoutRequest.status to APPROVED via updateSubjectStatus) has committed.
//
// Two things this hook owns that the generic engine has no notion of:
//   1. approvedAt — updateSubjectStatus only ever writes `status`; the
//      dedicated timestamp column is Handout's own concern.
//   2. Placing the Shopify order — same post-commit-only, Shopify-can-fail-
//      without-failing-the-approval posture EVENT_PROPOSAL's own hook
//      (runEventProposalFinalApprovalHooks) already follows: approveStage's
//      caller wraps this call in try/catch and logs a failure rather than
//      letting it bubble, so a Shopify outage never turns an already-
//      committed approval into a failed request. Returning
//      { orderPlacementFailed: true } on failure (instead of throwing)
//      additionally lets that failure surface to the frontend as a toast
//      on the approve response itself — same reasoning as EPC's
//      { stockCheckFailed }.
//
// The stock-availability check itself is NOT repeated here — approveHandout
// below already ran it, authoritatively, BEFORE ever calling the generic
// approveStage, and routes a shortfall to CANNOT_FULFIL instead of
// advancing the workflow at all. By the time this hook runs, stock is
// already known good.
// ─────────────────────────────────────────────────────────────────────────────

export const runHandoutFinalApprovalHook = async (
  handoutId: string,
): Promise<Record<string, unknown>> => {
  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: { approvedAt: new Date() },
  });

  try {
    await executeHandoutOrderPlacement(handoutId);
  } catch (error: any) {
    return { orderPlacementFailed: true, orderPlacementError: error.message };
  }

  return {};
};

// ── Approve ──────────────────────────────────────────────────────────────────
// Authoritative stock check against the live catalog (getStock, not
// listStock — listStock is cursor-paginated catalog browsing, not an
// exact-SKU availability check). A shortfall on any line auto-transitions
// to CANNOT_FULFIL with no Shopify call at all, per your call — the
// approver never has to make a manual decision at this point, and the
// generic engine's approveStage is never even called in that case — a
// shortfall is a Handout-specific terminal outcome the kernel has no
// concept of, so the WorkflowInstance is explicitly closed out (isActive:
// false) rather than left dangling IN_PROGRESS forever.
export const approveHandout = async (actor: Actor, handoutId: string) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isApprover)
    throw new ApiError(403, "Only an approver can approve this handout");
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.APPROVED,
  );
  if (!access.activeStageId) {
    throw new ApiError(
      409,
      "This handout has no active approval stage — its workflow may not have been assigned correctly",
    );
  }

  // thcmShopClient.getStock returns ThcmStockRow[] directly (not an object
  // with a `.lines` wrapper — that shape belongs to crf-shop.controller.ts's
  // own HTTP response, which wraps this same call for a different endpoint).
  // Requested quantities are summed per SKU before comparing, same reason
  // crfOrder.services.ts's evaluateSouvenirStock does it: two lines of the
  // same SKU must be checked together, not separately.
  const requestedBySku = new Map<string, number>();
  for (const item of access.handout.items) {
    requestedBySku.set(
      item.sku,
      (requestedBySku.get(item.sku) ?? 0) + item.quantity,
    );
  }
  const skus = [...requestedBySku.keys()];

  const stockRows = await thcmShopClient.getStock(skus, { fresh: true });
  const availableBySku = new Map(
    stockRows.map((row) => [row.sku, row.availableQty]),
  );

  const shortfall = [...requestedBySku.entries()].some(
    ([sku, requested]) => (availableBySku.get(sku) ?? 0) < requested,
  );

  if (shortfall) {
    const reason = "Automatic — stock shortfall detected at approval";
    await prisma.$transaction([
      prisma.handoutRequest.update({
        where: { id: handoutId },
        data: {
          status: HANDOUT_STATUS.CANNOT_FULFIL,
          cannotFulfilReason: reason,
        },
      }),
      // The kernel has no "cannot fulfil" outcome — close the workflow out
      // of band rather than leaving it IN_PROGRESS with no path forward.
      // activeWorkflowId came off the same getHandoutAccess call above, so
      // no extra lookup is needed here.
      ...(access.activeWorkflowId
        ? [
            prisma.workflowInstance.update({
              where: { id: access.activeWorkflowId },
              data: { isActive: false },
            }),
          ]
        : []),
    ]);
    await prisma.activityLog.create({
      data: {
        subjectType: "HANDOUT_REQUEST",
        subjectId: handoutId,
        actorId: actor.id,
        action: "CANNOT_FULFIL",
        workflowId: null,
        stageId: null,
        metadata: { comment: reason },
      },
    });
    await safeNotifyHandoutEvent({ handoutId, event: "CANNOT_FULFIL", actor });
    return getHandoutDetail(actor, handoutId);
  }

  // Stock is good — hand the actual state transition to the generic engine.
  // approveStage commits HandoutRequest.status -> APPROVED (via
  // updateSubjectStatus), writes its own ActivityLog "APPROVED" entry with
  // a real workflowId/stageId, sends the generic "fully approved"
  // notification to the requester, and then — strictly post-commit — runs
  // runHandoutFinalApprovalHook above (approvedAt + Shopify order).
  const hookResult = await approveStage({
    stageId: access.activeStageId,
    userId: actor.id,
    reason: "",
  });

  // Delivery has no generic-engine equivalent (see file header) — the
  // delivery person's "it's now your queue" notification is Handout-
  // specific and still fires here, same as before.
  await safeNotifyHandoutEvent({ handoutId, event: "APPROVED", actor });

  const detail = await getHandoutDetail(actor, handoutId);
  // Surfaced so the approver sees it immediately rather than discovering a
  // missing Shopify order only when the delivery team later opens the
  // request — same posture as EPC's stockCheckFailed toast.
  return hookResult?.orderPlacementFailed
    ? { ...detail, orderPlacementFailed: true }
    : detail;
};

// ── Reject ───────────────────────────────────────────────────────────────────
export const rejectHandout = async (
  actor: Actor,
  handoutId: string,
  reason: string,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isApprover)
    throw new ApiError(403, "Only an approver can reject this handout");
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.REJECTED,
  );
  if (!access.activeStageId) {
    throw new ApiError(
      409,
      "This handout has no active approval stage — its workflow may not have been assigned correctly",
    );
  }
  const comment = requireReason(reason, "reject this handout");

  // rejectStage commits HandoutRequest.status -> REJECTED (via
  // updateSubjectStatus) and sends the generic "rejected" notification —
  // but it writes no ActivityLog entry of its own (unlike approveStage),
  // and knows nothing of the dedicated rejectionReason column, so both are
  // still this file's job, as a small follow-up write.
  await rejectStage({
    stageId: access.activeStageId,
    userId: actor.id,
    reason: comment,
  });

  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: { rejectionReason: comment },
  });
  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "REJECTED",
      workflowId: null,
      stageId: access.activeStageId,
      metadata: { comment },
    },
  });

  return getHandoutDetail(actor, handoutId);
};

// ── Clarify (approver's third option, instead of approve/reject) ───────────
// UNCHANGED apart from isApprover now resolving from the active workflow
// stage (handoutsAccess.helper.ts) instead of a fixed env-var identity —
// clarify itself stays a pure HandoutRequest status flip, never touching
// the WorkflowInstance. See file header for why.
export const clarifyHandout = async (
  actor: Actor,
  handoutId: string,
  reason: string,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isApprover)
    throw new ApiError(403, "Only an approver can request clarification");
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.CLARIFICATION_REQUESTED,
  );
  const comment = requireReason(reason, "request clarification");

  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: {
      status: HANDOUT_STATUS.CLARIFICATION_REQUESTED,
      clarificationReason: comment,
    },
  });
  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "CLARIFICATION_REQUESTED",
      workflowId: null,
      stageId: null,
      metadata: { comment },
    },
  });
  await safeNotifyHandoutEvent({
    handoutId,
    event: "CLARIFICATION_REQUESTED",
    actor,
    comment,
  });

  return getHandoutDetail(actor, handoutId);
};

// ── Cancel (requester, PENDING_APPROVAL or CLARIFICATION_REQUESTED) ────────
// UNCHANGED — no role check here at all (isOwner only), so nothing about
// the approver-resolution change touches this function.
export const cancelHandout = async (
  actor: Actor,
  handoutId: string,
  reason: string,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isOwner)
    throw new ApiError(403, "Only the requester can cancel this handout");
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.CANCELLED,
  );
  const comment = requireReason(reason, "cancel this handout");

  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: { status: HANDOUT_STATUS.CANCELLED, cancellationReason: comment },
  });
  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "CANCELLED",
      workflowId: null,
      stageId: null,
      metadata: { comment },
    },
  });
  await safeNotifyHandoutEvent({
    handoutId,
    event: "CANCELLED",
    actor,
    comment,
  });

  return getHandoutDetail(actor, handoutId);
};

// ── Cannot fulfil (manual — delivery team, post-approval) ──────────────────
// UNCHANGED — isDeliveryTeam stays a fixed identity (see file header), so
// nothing about the approver-resolution change touches this function.
// Distinct entry point from approveHandout()'s automatic transition: this
// one fires when the delivery team discovers, after approval, that an item
// can't actually be handed out (damaged stock, discontinued line, etc.).
export const cannotFulfilHandout = async (
  actor: Actor,
  handoutId: string,
  reason: string,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isDeliveryTeam) {
    throw new ApiError(
      403,
      "Only the delivery team can mark this handout as cannot-fulfil",
    );
  }
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.CANNOT_FULFIL,
  );
  const comment = requireReason(reason, "mark this handout as cannot-fulfil");

  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: { status: HANDOUT_STATUS.CANNOT_FULFIL, cannotFulfilReason: comment },
  });
  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "CANNOT_FULFIL",
      workflowId: null,
      stageId: null,
      metadata: { comment },
    },
  });
  await safeNotifyHandoutEvent({
    handoutId,
    event: "CANNOT_FULFIL",
    actor,
    comment,
  });

  return getHandoutDetail(actor, handoutId);
};

// ── Deliver (delivery team, APPROVED -> CLOSED) ─────────────────────────────
// UNCHANGED — same reasoning as cannotFulfilHandout above.
export type DeliverHandoutInput = {
  handedToName: string;
  deliveredOn: string; // ISO datetime
  note?: string;
  checkedSkus: string[];
};

export const deliverHandout = async (
  actor: Actor,
  handoutId: string,
  input: DeliverHandoutInput,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);
  if (!access.isDeliveryTeam) {
    throw new ApiError(403, "Only the delivery team can deliver this handout");
  }
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.CLOSED,
  );

  if (!input.handedToName?.trim())
    throw new ApiError(400, "Handed-to name is required");

  const requestSkus = access.handout.items.map((item) => item.sku).sort();
  const checked = [...input.checkedSkus].sort();
  const allChecked =
    checked.length === requestSkus.length &&
    checked.every((sku, i) => sku === requestSkus[i]);
  if (!allChecked) {
    throw new ApiError(400, "Every item must be checked off before delivery");
  }

  // Delivery fields (handedToName/deliveredOn/deliveryNote/deliveredById)
  // live directly on HandoutRequest — there's no HandoutOrder.deliveredAt
  // etc. to update; HandoutOrder only holds the Shopify snapshot.
  await prisma.handoutRequest.update({
    where: { id: handoutId },
    data: {
      status: HANDOUT_STATUS.CLOSED,
      closedAt: new Date(),
      deliveredById: actor.id,
      handedToName: input.handedToName.trim(),
      deliveredOn: new Date(input.deliveredOn),
      deliveryNote: input.note?.trim() || null,
    },
  });

  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "DELIVERED",
      workflowId: null,
      stageId: null,
    },
  });
  await safeNotifyHandoutEvent({ handoutId, event: "DELIVERED", actor });

  return getHandoutDetail(actor, handoutId);
};

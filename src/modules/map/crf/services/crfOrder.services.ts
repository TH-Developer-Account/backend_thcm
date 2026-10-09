/**
 * modules/map/crfOrder.service.ts
 *
 * Everything that talks to Shopify on behalf of a CRF: the post-approval
 * stock check, the shortfall-swap flow, placing the order (full or
 * accept-partial-with-debit-note), retrying a failed attempt, and
 * cancelling a placed order. Synchronous, no queue — every function here
 * runs inside the HTTP request that triggered it (createCrf/replaceCrfItems
 * in crf.service.ts are the drafting-time equivalent; this file is
 * everything from EPC approval onward).
 *
 * No Shopify catalog data is ever persisted. Prices fetched here (for the
 * approval-time cap and for debit-note amounts) are used once, in memory,
 * to compute a total, and only that computed total is written to the
 * database — never the per-item price itself.
 */

import type { CRF, Prisma } from "../../../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import logger from "@shared/utils/logger";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  getCrfAccess,
  assertCrfAccess,
} from "@modules/map/crf/crfAccess.helper";
import {
  buildShopifyItemRows,
  type ShopifyCrfItemInput,
} from "@modules/map/crf/services/crf.services";
import {
  thcmShopClient,
  ThcmShopApiError,
  type ThcmCreateOrderRequest,
} from "@modules/map/crf/shopify";
import { notify } from "@notifications/notification.services";
import { getSubjectNotificationMeta } from "@notifications/notification.helper";
import { addMailJob } from "@mail/mail.service";

type Actor = AccessActor & { id: string };

// ─────────────────────────────────────────────────────────────────────────────
// evaluateSouvenirStock — the one place that asks THCM "is everything we
// want still available" and writes the answer onto each CrfItem. Used by
// the post-approval check, the shortfall-swap flow, and the stock-conflict
// handler in executeOrderPlacement below, so "what counts as short" exists
// exactly once.
//
// Requested quantities are summed per SKU before comparing to availableQty
// — availableQty is a per-SKU total, not per-line, so two CrfItem rows that
// happen to name the same SKU must be checked together, not separately.
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateSouvenirStock(
  tx: Prisma.TransactionClient,
  crfId: string,
): Promise<{
  allInStock: boolean;
  priceBySku: Map<string, number>;
  requestedBySku: Map<string, number>;
}> {
  // Only lines still "live" — a DEBITED or already-ORDERED line is a
  // resolved historical fact, not something a later stock refresh should
  // ever touch or flip back to REQUESTED/OUT_OF_STOCK.
  const souvenirItems = await tx.crfItem.findMany({
    where: {
      crfId,
      category: "SOUVENIR",
      status: { in: ["REQUESTED", "OUT_OF_STOCK"] },
    },
  });

  if (souvenirItems.length === 0) {
    return {
      allInStock: true,
      priceBySku: new Map(),
      requestedBySku: new Map(),
    };
  }

  const skus = [...new Set(souvenirItems.map((item) => item.sku as string))];
  const stockRows = await thcmShopClient.getStock(skus, { fresh: true });

  const availableBySku = new Map(
    stockRows.map((row) => [row.sku as string, row.availableQty]),
  );
  const priceBySku = new Map(
    stockRows.map((row) => [row.sku as string, Number(row.price)]),
  );

  const requestedBySku = new Map<string, number>();
  for (const item of souvenirItems) {
    const sku = item.sku as string;
    requestedBySku.set(
      sku,
      (requestedBySku.get(sku) ?? 0) + (item.requestedQty ?? 0),
    );
  }

  const shortSkus = new Set<string>();
  for (const [sku, requestedQty] of requestedBySku) {
    const availableQty = availableBySku.get(sku) ?? 0; // unknown SKU → treated as 0 available
    if (requestedQty > availableQty) shortSkus.add(sku);
  }

  await Promise.all(
    souvenirItems.map((item) =>
      tx.crfItem.update({
        where: { id: item.id },
        data: {
          status: shortSkus.has(item.sku as string)
            ? "OUT_OF_STOCK"
            : "REQUESTED",
        },
      }),
    ),
  );

  return { allInStock: shortSkus.size === 0, priceBySku, requestedBySku };
}

// Applies an evaluateSouvenirStock result to the CRF's own status — but
// only while the CRF is still in one of the two statuses a stock refresh
// is allowed to move between. A refresh triggered after the order is
// already placed (or cancelled, or closed) must not clobber that.
async function applyStockResultToCrf(
  tx: Prisma.TransactionClient,
  crfId: string,
  allInStock: boolean,
): Promise<void> {
  const crf = await tx.cRF.findUnique({ where: { id: crfId } });
  if (!crf) throw new ApiError(404, "CRF not found");
  if (crf.status !== "APPROVED" && crf.status !== "STOCK_SHORTFALL") return;

  await tx.cRF.update({
    where: { id: crfId },
    data: { status: allInStock ? "APPROVED" : "STOCK_SHORTFALL" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications — in-app notify() + email addMailJob(), mirroring the same
// two-channel pairing workflow.service.ts already uses for approval events
// (see notifyAboutWorkflowEvent/emailStageApprovers there). The one thing
// this file doesn't have ready-made is a workspaceId: workflow.service.ts
// gets its from the WorkflowInstance row, but order/stock events here have
// no workflow in play, so it's resolved from the CRF owner's own
// WorkspaceUser row instead (single-workspace system today — see
// auth.middleware.ts's "Single-workspace system today" comment).
//
// Fired AFTER the transaction that changed the CRF has committed, never
// from inside it — same reasoning as the Shopify HTTP calls above: a side
// effect must not run while holding a DB transaction's locks. Each call
// site wraps the call in try/catch (via safeNotifyCrfEvent) so a
// notification failure can never turn an operation that already succeeded
// into a failed request — the same defensive-logging posture
// mail.service.ts and workflow.service.ts's postFinalApprovalHook use.
// ─────────────────────────────────────────────────────────────────────────────

async function getOwnerWorkspaceId(ownerId: string): Promise<string | null> {
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { workspaceUsers: { select: { workspaceId: true }, take: 1 } },
  });
  return owner?.workspaceUsers[0]?.workspaceId ?? null;
}

// MAP's app administrators for this workspace, minus the owner themself
// (the owner is always notified separately — this is only for the
// "someone else needs to act" fan-out on shortfall/failed).
async function getMapAdminIds(
  workspaceId: string,
  excludeUserId: string,
): Promise<string[]> {
  const admins = await prisma.appAdministrator.findMany({
    where: { workspaceId, app: { key: "MAP" }, userId: { not: excludeUserId } },
    select: { userId: true },
  });
  return admins.map((admin) => admin.userId);
}

async function notifyCrfEvent({
  recipientIds,
  workspaceId,
  epcId,
  title,
  body,
  templateName,
  templateData,
}: {
  recipientIds: string[];
  workspaceId: string;
  epcId: string;
  title: string;
  body: string;
  templateName: string;
  templateData: Record<string, unknown>;
}): Promise<void> {
  const uniqueIds = [...new Set(recipientIds)];
  if (uniqueIds.length === 0) return;

  // Reuses the same subject → {displayLabel, link} resolver
  // workflow.service.ts's approval notifications already use, rather than
  // hand-building the link and leaving the template's subjectLabel empty.
  const [subjectMeta, recipients] = await Promise.all([
    getSubjectNotificationMeta("EVENT_PROPOSAL", epcId),
    prisma.user.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, email: true },
    }),
  ]);
  const link = subjectMeta?.link ?? `/map/epc/${epcId}`;
  const subjectLabel = subjectMeta?.displayLabel ?? "CRF";

  await Promise.all([
    ...recipients.map((recipient) =>
      notify({
        workspaceId,
        recipientId: recipient.id,
        type: "GENERIC",
        title,
        body,
        link,
        metadata: {
          appKey: "MAP",
          subjectType: "EVENT_PROPOSAL",
          subjectId: epcId,
        },
      }),
    ),
    ...recipients
      .filter((recipient) => recipient.email)
      .map((recipient) =>
        addMailJob({
          to: recipient.email as string,
          subject: title,
          templateName,
          templateData: {
            ...templateData,
            subjectLabel,
            dashboardUrl: `${process.env.FRONTEND_URL ?? ""}${link}`,
          },
        }),
      ),
  ]);
}

async function safeNotifyCrfEvent(
  params: Parameters<typeof notifyCrfEvent>[0],
): Promise<void> {
  try {
    await notifyCrfEvent(params);
  } catch (error: any) {
    logger.error(
      `[crfOrder.service] Notification failed for EPC ${params.epcId}: ${error.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runPostApprovalStockCheck — called by the EPC workflow's final-approval
// hook (workflowSubject.helper.ts / workflow.service.ts). System-triggered,
// not a user action, so there's no actor/permission check here — the caller
// already represents the approval event itself (actorId is left null on
// the ActivityLog rows this writes, same as any other system-triggered
// event).
// ─────────────────────────────────────────────────────────────────────────────

// Thin epcId → crfId lookup for the workflow hook below, which only has
// the EventProposal's id (the workflow's `subjectId`) to work with. Not
// every EPC has a CRF (Souvenirs/CRF is opt-in per EPC), so a miss here is
// a no-op, not an error.
export async function runPostApprovalStockCheckForEpc(
  epcId: string,
): Promise<void> {
  const crf = await prisma.cRF.findUnique({ where: { epcId } });
  if (!crf) return;
  await runPostApprovalStockCheck(crf.id);
}

export async function runPostApprovalStockCheck(crfId: string): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const souvenirCount = await tx.crfItem.count({
      where: { crfId, category: "SOUVENIR" },
    });

    // Nothing to ever order from Shopify — the CRF's work ends at approval.
    if (souvenirCount === 0) {
      const crf = await tx.cRF.update({
        where: { id: crfId },
        data: { status: "CLOSED", approvedAt: new Date() },
      });

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: crf.epcId,
          actorId: null,
          action: "CRF_CLOSED",
          workflowId: null,
          stageId: null,
          metadata: {
            reason: "CRF had no souvenir lines — closed on approval.",
          },
        },
      });

      return null; // nothing to notify — no shortage, no owner action needed
    }

    const { allInStock, priceBySku, requestedBySku } =
      await evaluateSouvenirStock(tx, crfId);

    let souvenirTotal = 0;
    for (const [sku, qty] of requestedBySku) {
      souvenirTotal += qty * (priceBySku.get(sku) ?? 0);
    }

    const crf = await tx.cRF.update({
      where: { id: crfId },
      data: {
        status: allInStock ? "APPROVED" : "STOCK_SHORTFALL",
        approvedAt: new Date(),
        souvenirTotalAtApproval: souvenirTotal,
      },
    });

    if (!allInStock) {
      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: crf.epcId,
          actorId: null,
          action: "CRF_STOCK_SHORTFALL",
          workflowId: null,
          stageId: null,
          metadata: { reason: "Post-approval stock check found a shortage." },
        },
      });
    }

    return { crf, allInStock };
  });

  if (!result || result.allInStock) return;

  const { crf } = result;
  const workspaceId = await getOwnerWorkspaceId(crf.created_by_id);
  if (!workspaceId) {
    logger.error(
      `[crfOrder.service] CRF owner ${crf.created_by_id} has no workspace membership — skipping shortfall notification`,
    );
    return;
  }

  const adminIds = await getMapAdminIds(workspaceId, crf.created_by_id);
  await safeNotifyCrfEvent({
    recipientIds: [crf.created_by_id, ...adminIds],
    workspaceId,
    epcId: crf.epcId,
    title: "Souvenir stock shortfall",
    body: "Some souvenir items on your CRF are out of stock. Swap the affected lines, or place the order accepting the shortfall as a debit note.",
    templateName: "crf-stock-shortfall",
    templateData: { crfId: crf.id },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// swapSouvenirLines — owner-only, STOCK_SHORTFALL-only. Full replace of the
// souvenir lines (catalog lines untouched), re-checked against the
// approval-time value cap: the swapped-in set can't cost more than what was
// originally approved, since that's the whole point of freezing
// souvenirTotalAtApproval at approval time.
// ─────────────────────────────────────────────────────────────────────────────

export async function swapSouvenirLines(
  actor: Actor,
  crfId: string,
  items: ShopifyCrfItemInput[],
) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner) {
    throw new ApiError(403, "Only the CRF's creator can swap souvenir lines");
  }
  if (access.crf.status !== "STOCK_SHORTFALL") {
    throw new ApiError(
      409,
      `Souvenir lines can only be swapped while the CRF is STOCK_SHORTFALL (current status: ${access.crf.status})`,
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.crfItem.deleteMany({ where: { crfId, category: "SOUVENIR" } });

    const rows = buildShopifyItemRows(crfId, items);
    await tx.crfItem.createMany({ data: rows });

    const { allInStock, priceBySku, requestedBySku } =
      await evaluateSouvenirStock(tx, crfId);

    let newTotal = 0;
    for (const [sku, qty] of requestedBySku) {
      newTotal += qty * (priceBySku.get(sku) ?? 0);
    }

    const cap = Number(access.crf.souvenirTotalAtApproval ?? 0);
    if (cap > 0 && newTotal > cap) {
      throw new ApiError(
        400,
        `Swapped souvenir total (${newTotal.toFixed(2)}) exceeds the approved cap (${cap.toFixed(2)})`,
      );
    }

    await applyStockResultToCrf(tx, crfId, allInStock);

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: access.crf.epcId,
        actorId: actor.id,
        action: "CRF_SOUVENIR_LINES_SWAPPED",
        workflowId: null,
        stageId: null,
        metadata: { reason: "Souvenir lines swapped after stock shortfall." },
      },
    });

    return { id: crfId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// executeOrderPlacement — the actual Create Order call, shared by placeOrder
// (owner, APPROVED/STOCK_SHORTFALL) and retryOrder (owner or admin,
// ORDER_FAILED) after each does its own permission/status check. Kept as
// one function because the Shopify call and its response handling must
// behave identically regardless of which caller reached it.
// ─────────────────────────────────────────────────────────────────────────────

async function executeOrderPlacement(
  actor: Actor,
  crf: CRF,
  acceptPartial: boolean,
) {
  if (
    !crf.recipientName ||
    !crf.recipientPhone ||
    !crf.recipientEmail ||
    !crf.addressLine1 ||
    !crf.addressCity ||
    !crf.addressState ||
    !crf.addressPincode
  ) {
    throw new ApiError(
      409,
      "Dispatch details must be completed before placing the order",
    );
  }

  // REQUESTED/OUT_OF_STOCK only — a DEBITED line from an earlier
  // accept-partial attempt must never be re-ordered, and an already-ORDERED
  // line can't coexist with these statuses in practice (see
  // evaluateSouvenirStock's comment), but excluding them here too is the
  // cheap insurance against ever double-ordering or re-billing a line.
  const souvenirItems = await prisma.crfItem.findMany({
    where: {
      crfId: crf.id,
      category: "SOUVENIR",
      status: { in: ["REQUESTED", "OUT_OF_STOCK"] },
    },
  });

  const itemsToOrder = souvenirItems.filter(
    (item) => item.status === "REQUESTED",
  );
  const shortItems = souvenirItems.filter(
    (item) => item.status === "OUT_OF_STOCK",
  );

  if (itemsToOrder.length === 0) {
    throw new ApiError(400, "No souvenir items available to order");
  }
  if (shortItems.length > 0 && !acceptPartial) {
    throw new ApiError(
      409,
      "Some souvenir items are out of stock — swap them or place the order accepting the shortfall as a debit note",
    );
  }
  if (shortItems.length === 0 && acceptPartial) {
    throw new ApiError(400, "No shortfall to accept — nothing is out of stock");
  }

  let debitNoteAmount: number | undefined;
  if (acceptPartial) {
    const shortSkus = [
      ...new Set(shortItems.map((item) => item.sku as string)),
    ];
    // Fresh, uncached price lookup — never reused from an earlier call,
    // per "no Shopify catalog data persisted, ever" (not even transiently
    // across requests).
    const freshStock = await thcmShopClient.getStock(shortSkus, {
      fresh: true,
    });
    const priceBySku = new Map(
      freshStock.map((row) => [row.sku as string, Number(row.price)]),
    );
    debitNoteAmount = shortItems.reduce(
      (sum, item) =>
        sum +
        (item.requestedQty ?? 0) * (priceBySku.get(item.sku as string) ?? 0),
      0,
    );
  }

  const payload: ThcmCreateOrderRequest = {
    items: itemsToOrder.map((item) => ({
      sku: item.sku as string,
      quantity: item.requestedQty as number,
    })),
    name: crf.recipientName,
    email: crf.recipientEmail,
    phone: crf.recipientPhone,
    channel: "MAP",
    shippingAddress: {
      country: crf.addressCountry ?? "India",
      province: crf.addressState,
      city: crf.addressCity,
      zip: crf.addressPincode,
      address1: crf.addressLine1,
      address2: crf.addressLine2 ?? undefined,
      company: crf.addressCompany ?? undefined,
    },
  };

  let order;
  try {
    order = await thcmShopClient.createOrder(payload);
  } catch (error) {
    if (error instanceof ThcmShopApiError && error.status === 409) {
      // Create Order re-checks stock live and found a race (something sold
      // out between our own check and this call). Re-evaluate so
      // CrfItem/CRF status reflects reality rather than parsing THCM's
      // free-text shortage message for SKUs.
      await prisma.$transaction(async (tx) => {
        const { allInStock } = await evaluateSouvenirStock(tx, crf.id);
        await applyStockResultToCrf(tx, crf.id, allInStock);
      });
      throw new ApiError(
        409,
        "Stock changed just before the order was placed — items have been re-checked, please review and try again",
      );
    }
    if (
      error instanceof ThcmShopApiError &&
      error.status === 400 &&
      error.code
    ) {
      // Address validation (INVALID_COUNTRY / INVALID_PIN / PIN_STATE_MISMATCH
      // / PIN_CITY_MISMATCH) — fixable by editing dispatch details; leave
      // CRF status exactly as it was.
      throw error;
    }

    // Anything else (500 misconfiguration, 502 Shopify unreachable, or a
    // 400 we didn't anticipate) — mark as failed so retryOrder becomes
    // available, log it, notify, and bubble the original error.
    await prisma.cRF.update({
      where: { id: crf.id },
      data: { status: "ORDER_FAILED" },
    });

    await prisma.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: crf.epcId,
        actorId: actor.id,
        action: "CRF_ORDER_FAILED",
        workflowId: null,
        stageId: null,
        metadata: {
          reason:
            error instanceof Error ? error.message : "Order placement failed.",
        },
      },
    });

    const workspaceId = await getOwnerWorkspaceId(crf.created_by_id);
    if (workspaceId) {
      const adminIds = await getMapAdminIds(workspaceId, crf.created_by_id);
      await safeNotifyCrfEvent({
        recipientIds: [crf.created_by_id, ...adminIds],
        workspaceId,
        epcId: crf.epcId,
        title: "Souvenir order failed",
        body: "Placing the souvenir order failed. The CRF owner or an administrator can retry it.",
        templateName: "crf-order-failed",
        templateData: { crfId: crf.id },
      });
    } else {
      logger.error(
        `[crfOrder.service] CRF owner ${crf.created_by_id} has no workspace membership — skipping order-failed notification`,
      );
    }

    throw error;
  }

  const crfOrder = await prisma.$transaction(async (tx) => {
    const crfOrder = await tx.crfOrder.create({
      data: {
        crfId: crf.id,
        shopifyOrderId: order.shopifyOrderId,
        totalPrice: Number(order.totalPrice),
        lines: order.lineItems.map((line) => ({
          sku: line.sku,
          title: line.title,
          quantity: line.quantity,
          unitPrice: line.price,
          lineTotal: (Number(line.price) * line.quantity).toFixed(2),
        })),
        debitNoteAmount,
      },
    });

    await tx.crfItem.updateMany({
      where: { id: { in: itemsToOrder.map((item) => item.id) } },
      data: { status: "ORDERED" },
    });
    if (shortItems.length > 0) {
      await tx.crfItem.updateMany({
        where: { id: { in: shortItems.map((item) => item.id) } },
        data: { status: "DEBITED" },
      });
    }

    await tx.cRF.update({ where: { id: crf.id }, data: { status: "ORDERED" } });

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: crf.epcId,
        actorId: actor.id,
        action: "CRF_ORDER_PLACED",
        workflowId: null,
        stageId: null,
        metadata: {
          shopifyOrderId: order.shopifyOrderId,
          debitNoteAmount: debitNoteAmount ?? null,
        },
      },
    });

    return crfOrder;
  });

  const workspaceId = await getOwnerWorkspaceId(crf.created_by_id);
  if (workspaceId) {
    await safeNotifyCrfEvent({
      recipientIds: [crf.created_by_id],
      workspaceId,
      epcId: crf.epcId,
      title: "Souvenir order placed",
      body:
        debitNoteAmount !== undefined
          ? `Your souvenir order has been placed. A debit note of ₹${debitNoteAmount.toFixed(2)} applies for the out-of-stock items.`
          : "Your souvenir order has been placed successfully.",
      templateName: "crf-order-placed",
      templateData: {
        crfId: crf.id,
        shopifyOrderId: crfOrder.shopifyOrderId,
        totalPrice: crfOrder.totalPrice.toString(),
        debitNoteAmount:
          debitNoteAmount !== undefined ? debitNoteAmount.toFixed(2) : null,
      },
    });
  } else {
    logger.error(
      `[crfOrder.service] CRF owner ${crf.created_by_id} has no workspace membership — skipping order-placed notification`,
    );
  }

  return crfOrder;
}

// ─────────────────────────────────────────────────────────────────────────────
// placeOrder — owner-only, APPROVED or STOCK_SHORTFALL. acceptPartial must
// match the CRF's actual state: true only makes sense when something is
// genuinely short (STOCK_SHORTFALL), never on a clean APPROVED CRF.
// ─────────────────────────────────────────────────────────────────────────────

export async function placeOrder(
  actor: Actor,
  crfId: string,
  opts: { acceptPartial?: boolean } = {},
) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner) {
    throw new ApiError(403, "Only the CRF's creator can place the order");
  }
  if (
    access.crf.status !== "APPROVED" &&
    access.crf.status !== "STOCK_SHORTFALL"
  ) {
    throw new ApiError(
      409,
      `The order can only be placed while the CRF is APPROVED or STOCK_SHORTFALL (current status: ${access.crf.status})`,
    );
  }

  return executeOrderPlacement(actor, access.crf, Boolean(opts.acceptPartial));
}

// ─────────────────────────────────────────────────────────────────────────────
// retryOrder — owner OR admin, ORDER_FAILED only. Always a full retry
// (never accept-partial): ORDER_FAILED only happens from a non-stock
// failure (a stock conflict routes back to STOCK_SHORTFALL instead), so
// there's never a shortfall to accept at retry time.
// ─────────────────────────────────────────────────────────────────────────────

export async function retryOrder(actor: Actor, crfId: string) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner && !access.isAdmin) {
    throw new ApiError(
      403,
      "Only the CRF's creator or an administrator can retry the order",
    );
  }
  if (access.crf.status !== "ORDER_FAILED") {
    throw new ApiError(
      409,
      `The order can only be retried while the CRF is ORDER_FAILED (current status: ${access.crf.status})`,
    );
  }

  return executeOrderPlacement(actor, access.crf, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelOrder — owner OR admin, ORDERED only. Only items that were actually
// ORDERED go back to REQUESTED (their stock is what Shopify handed back);
// items already DEBITED keep that status — their debit note is a recorded
// fact on the (now cancelled) CrfOrder row, and cancelling the order that
// was placed doesn't retroactively undo a debit note that may already be
// in motion for Tata Hitachi to settle outside MAP.
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelOrder(
  actor: Actor,
  crfId: string,
  reason?: string,
) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner && !access.isAdmin) {
    throw new ApiError(
      403,
      "Only the CRF's creator or an administrator can cancel the order",
    );
  }
  if (access.crf.status !== "ORDERED") {
    throw new ApiError(
      409,
      `The order can only be cancelled while the CRF is ORDERED (current status: ${access.crf.status})`,
    );
  }

  const crfOrder = await prisma.crfOrder.findUnique({ where: { crfId } });
  if (!crfOrder) throw new ApiError(404, "CRF order not found");

  // Left to bubble as-is on failure (409 already cancelled/fulfilled, 502
  // retryable) — cancelOrder does not retry or reinterpret THCM's response.
  await thcmShopClient.cancelOrder(crfOrder.shopifyOrderId);

  const result = await prisma.$transaction(async (tx) => {
    await tx.crfOrder.update({
      where: { crfId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancelReason: reason ?? null,
      },
    });

    await tx.crfItem.updateMany({
      where: { crfId, category: "SOUVENIR", status: "ORDERED" },
      data: { status: "REQUESTED" },
    });

    await tx.cRF.update({ where: { id: crfId }, data: { status: "APPROVED" } });

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: access.crf.epcId,
        actorId: actor.id,
        action: "CRF_ORDER_CANCELLED",
        workflowId: null,
        stageId: null,
        metadata: {
          reason: reason ?? "CRF order cancelled.",
          shopifyOrderId: crfOrder.shopifyOrderId,
        },
      },
    });

    return { id: crfId };
  });

  const workspaceId = await getOwnerWorkspaceId(access.crf.created_by_id);
  if (workspaceId) {
    await safeNotifyCrfEvent({
      recipientIds: [access.crf.created_by_id],
      workspaceId,
      epcId: access.crf.epcId,
      title: "Souvenir order cancelled",
      body: reason
        ? `Your souvenir order was cancelled: ${reason}`
        : "Your souvenir order was cancelled.",
      templateName: "crf-order-cancelled",
      templateData: {
        crfId,
        shopifyOrderId: crfOrder.shopifyOrderId,
        reason: reason ?? null,
      },
    });
  } else {
    logger.error(
      `[crfOrder.service] CRF owner ${access.crf.created_by_id} has no workspace membership — skipping order-cancelled notification`,
    );
  }

  return result;
}

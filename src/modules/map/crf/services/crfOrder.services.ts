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
 * Also owns the EPC-final-approval marketing forward: once an EPC is fully
 * approved, its CRF's Printed Material/Artwork lines are emailed to the
 * marketing team (souvenirs stay out of this — those are Shopify-fulfilled
 * and covered by the stock-check/order flow below).
 *
 * No Shopify catalog data is ever persisted. Prices fetched here (for the
 * approval-time cap and for debit-note amounts) are used once, in memory,
 * to compute a total, and only that computed total is written to the
 * database — never the per-item price itself.
 *
 * Shortfall budget accounting (CRF.shortfallAmount / CRF.pendingDebitAmount):
 *   CRF.souvenirTotalAtApproval is a historical snapshot only — the total
 *   value of ALL approved souvenir lines (in-stock + short) at the moment
 *   the EPC was approved. It is never re-used as the swap budget, because
 *   the in-stock lines it includes are re-priced live on every render
 *   (see SouvenirCatalog/backfillSouvenirDisplayFields on the frontend),
 *   which let that cap drift away from the real shortfall value.
 *   CRF.shortfallAmount is instead frozen to just the OUT_OF_STOCK lines'
 *   value whenever the CRF enters or re-enters STOCK_SHORTFALL (first
 *   post-approval check, or a swap that's still short afterward) — this is
 *   the real swap budget, checked in swapSouvenirLines below. When a swap
 *   fully resolves the shortfall for less than that budget, the unused
 *   balance accumulates in CRF.pendingDebitAmount, which executeOrderPlacement
 *   folds into the placed order's debitNoteAmount and then clears.
 */

import type { CRF, Prisma } from "../../../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import logger from "@shared/utils/logger";
import type { AccessActor } from "@rbac/profile/access.types";
import { getCrfAccess, assertCrfAccess } from "@map/crf/crfAccess.helper";
import {
  buildShopifyItemRows,
  type ShopifyCrfItemInput,
} from "@map/crf/services/crf.services";
import {
  thcmShopClient,
  ThcmShopApiError,
  type ThcmCreateOrderRequest,
} from "@map/crf/shopify";
import { notify } from "@notifications/notification.services";
import { getSubjectNotificationMeta } from "@notifications/notification.helper";
import { addMailJob } from "@mail/mail.service";

type Actor = AccessActor & { id: string };

// ─────────────────────────────────────────────────────────────────────────────
// getForcedOutOfStockSkus — TEST-ONLY override, never active in production.
//
// THCM's real stock is almost always available, which makes the shortfall
// path (swap lines / accept debit note) impossible to exercise end-to-end
// without actually depleting real inventory in the live store. This lets a
// developer force specific SKUs to read as out-of-stock, without touching
// real Shopify data.
//
// Read fresh on every call rather than cached at module load, so a
// developer can change THCM_FORCE_OUT_OF_STOCK_SKUS and re-test without
// restarting the process. Hard-gated on NODE_ENV — returns an empty set
// unconditionally in production, so this can never affect a real order
// even if the env var is accidentally left set.
// ─────────────────────────────────────────────────────────────────────────────

function getForcedOutOfStockSkus(): Set<string> {
  if (process.env.NODE_ENV === "production") return new Set();

  const raw = process.env.THCM_FORCE_OUT_OF_STOCK_SKUS;
  if (!raw) return new Set();

  return new Set(
    raw
      .split(",")
      .map((sku) => sku.trim())
      .filter((sku) => sku.length > 0),
  );
}

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
//
// Also returns shortfallValue — the Σ(price × requestedQty) over just the
// short SKUs — so every caller that needs to freeze CRF.shortfallAmount
// (runPostApprovalStockCheck, swapSouvenirLines) computes it the same way,
// rather than each re-deriving it from priceBySku/requestedBySku itself.
//
// Throws (does not catch) if thcmShopClient.getStock itself fails — e.g.
// THCM Shop is down/unreachable. That's deliberate: this function's job is
// only to answer "what's in stock", not to decide what a failure to answer
// means for the CRF. runPostApprovalStockCheck (the only caller that can
// reach this from an unattended context — the post-approval hook) is what
// catches it and marks the CRF STOCK_CHECK_FAILED; swapSouvenirLines and
// executeOrderPlacement are both user-initiated requests, so letting the
// error bubble there and surface as a normal failed request is correct too.
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateSouvenirStock(
  tx: Prisma.TransactionClient,
  crfId: string,
): Promise<{
  allInStock: boolean;
  priceBySku: Map<string, number>;
  requestedBySku: Map<string, number>;
  shortfallValue: number;
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
      shortfallValue: 0,
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

  // TEST-ONLY — see getForcedOutOfStockSkus above. Resolved once per call
  // and unioned into the real shortage set below rather than skipping the
  // real THCM call: the real price/availability data is still fetched and
  // used, only the in-stock/short verdict for these specific SKUs is
  // overridden, so everything downstream (debit-note pricing, etc.) keeps
  // behaving exactly as it would for a genuine shortage.
  const forcedOutOfStockSkus = getForcedOutOfStockSkus();

  const shortSkus = new Set<string>();
  for (const [sku, requestedQty] of requestedBySku) {
    const availableQty = availableBySku.get(sku) ?? 0; // unknown SKU → treated as 0 available
    if (requestedQty > availableQty || forcedOutOfStockSkus.has(sku)) {
      shortSkus.add(sku);
    }
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

  let shortfallValue = 0;
  for (const sku of shortSkus) {
    shortfallValue +=
      (requestedBySku.get(sku) ?? 0) * (priceBySku.get(sku) ?? 0);
  }

  return {
    allInStock: shortSkus.size === 0,
    priceBySku,
    requestedBySku,
    shortfallValue,
  };
}

// Applies an evaluateSouvenirStock result to the CRF's own status — but
// only while the CRF is still in one of the statuses a stock refresh is
// allowed to move between. A refresh triggered after the order is already
// placed (or cancelled, or closed) must not clobber that. extraData is
// merged into the same update so callers that also need to freeze
// shortfallAmount/pendingDebitAmount (swapSouvenirLines) don't have to
// duplicate this status-transition guard with a second write.
async function applyStockResultToCrf(
  tx: Prisma.TransactionClient,
  crfId: string,
  allInStock: boolean,
  extraData: Prisma.CRFUpdateInput = {},
): Promise<void> {
  const crf = await tx.cRF.findUnique({ where: { id: crfId } });
  if (!crf) throw new ApiError(404, "CRF not found");
  if (
    crf.status !== "APPROVED" &&
    crf.status !== "STOCK_SHORTFALL" &&
    crf.status !== "STOCK_CHECK_FAILED"
  ) {
    return;
  }

  await tx.cRF.update({
    where: { id: crfId },
    data: { status: allInStock ? "APPROVED" : "STOCK_SHORTFALL", ...extraData },
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
// workflow.service.ts's post-final-approval hook wrapper uses.
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
// "someone else needs to act" fan-out on shortfall/failed/ready-to-order).
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
// markStockCheckFailed — the Shopify-down branch of the post-approval
// stock check. Called OUTSIDE the failed $transaction (which has already
// rolled back and carries none of its intended writes), as its own
// best-effort update: mark the CRF STOCK_CHECK_FAILED, log it, and notify
// owner + admins with a retry prompt. Mirrors the ORDER_FAILED branch in
// executeOrderPlacement below — same audience, same shape, just a
// different failure point in the pipeline (checking stock vs. placing the
// order).
//
// Deliberately NOT wrapped in its own try/catch the way safeNotifyCrfEvent
// wraps notifications: if the CRF status update itself fails (DB down),
// there's nothing else this function can do — it bubbles, and the caller
// (runPostApprovalStockCheck) already treats "the whole check failed" as
// its outcome either way.
// ─────────────────────────────────────────────────────────────────────────────

async function markStockCheckFailed(crfId: string): Promise<void> {
  const crf = await prisma.cRF.update({
    where: { id: crfId },
    data: { status: "STOCK_CHECK_FAILED" },
  });

  await prisma.activityLog.create({
    data: {
      subjectType: "EVENT_PROPOSAL",
      subjectId: crf.epcId,
      actorId: null,
      action: "CRF_STOCK_CHECK_FAILED",
      workflowId: null,
      stageId: null,
      metadata: {
        reason: "Post-approval stock check could not reach the souvenir store.",
      },
    },
  });

  const workspaceId = await getOwnerWorkspaceId(crf.created_by_id);
  if (!workspaceId) {
    logger.error(
      `[crfOrder.service] CRF owner ${crf.created_by_id} has no workspace membership — skipping stock-check-failed notification`,
    );
    return;
  }
  const adminIds = await getMapAdminIds(workspaceId, crf.created_by_id);

  await safeNotifyCrfEvent({
    recipientIds: [crf.created_by_id, ...adminIds],
    workspaceId,
    epcId: crf.epcId,
    title: "Souvenir stock check failed",
    body: "We couldn't reach the souvenir store to confirm stock after approval. Retry the check from the CRF once the store is back up.",
    templateName: "crf-stock-check-failed",
    templateData: { crfId: crf.id },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runPostApprovalStockCheck — called by the EPC workflow's final-approval
// hook (workflowSubject.helper.ts's postFinalApprovalHooks, invoked from
// workflow.service.ts's approveStage, via runEventProposalFinalApprovalHooks
// below), AND by retryStockCheck below (a user-initiated retry once the
// CRF is STOCK_CHECK_FAILED). System-triggered in the first case, so
// there's no actor/permission check in here — the caller already
// represents either the approval event itself or a permission check it
// already ran (actorId is left null on the ActivityLog rows this writes,
// same as any other system-triggered event).
//
// Returns { failed: boolean } rather than throwing on a Shopify outage:
// the approval-hook caller needs to keep going (approval already
// succeeded, see workflow.service.ts) and surface the failure as data for
// a toast, not as a thrown error; retryStockCheck (a real user request)
// is the one place that turns `failed: true` back into a thrown ApiError.
// ─────────────────────────────────────────────────────────────────────────────

// Thin epcId → crfId lookup for the workflow hook below, which only has
// the EventProposal's id (the workflow's `subjectId`) to work with. Not
// every EPC has a CRF (Souvenirs/CRF is opt-in per EPC), so a miss here is
// a no-op, not a failure.
export async function runPostApprovalStockCheckForEpc(
  epcId: string,
): Promise<{ failed: boolean }> {
  const crf = await prisma.cRF.findUnique({ where: { epcId } });
  if (!crf) return { failed: false };
  return runPostApprovalStockCheck(crf.id);
}

export async function runPostApprovalStockCheck(
  crfId: string,
): Promise<{ failed: boolean }> {
  let result: { crf: CRF; allInStock: boolean } | null;

  try {
    result = await prisma.$transaction(async (tx) => {
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

      const { allInStock, priceBySku, requestedBySku, shortfallValue } =
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
          // The real swap budget going forward — just the short lines'
          // value, frozen the moment the shortfall is first detected. Null
          // when everything's in stock (there's nothing to swap against).
          shortfallAmount: allInStock ? null : shortfallValue,
        },
      });

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: crf.epcId,
          actorId: null,
          action: allInStock ? "CRF_READY_FOR_ORDER" : "CRF_STOCK_SHORTFALL",
          workflowId: null,
          stageId: null,
          metadata: {
            reason: allInStock
              ? "Post-approval stock check found everything in stock."
              : "Post-approval stock check found a shortage.",
          },
        },
      });

      return { crf, allInStock };
    });
  } catch (error: any) {
    // The transaction above has already rolled back — none of its writes
    // happened. Shopify being unreachable (THCM shop down/timeout) is the
    // expected cause here; mark the CRF as such so the owner/admin can see
    // why it's stuck and retry, instead of it silently staying wherever
    // it was before this hook ran.
    logger.error(
      `[crfOrder.service] Stock check failed for CRF ${crfId}: ${error.message}`,
    );
    await markStockCheckFailed(crfId);
    return { failed: true };
  }

  if (!result) return { failed: false };

  // ── Notify — strictly after the transaction has committed ─────────────
  // Both outcomes (ready-to-order and shortfall) notify the same audience
  // (owner + MAP admins), so the workspace/admin lookup is resolved once
  // here rather than duplicated per branch.
  const { crf, allInStock } = result;
  const workspaceId = await getOwnerWorkspaceId(crf.created_by_id);
  if (!workspaceId) {
    logger.error(
      `[crfOrder.service] CRF owner ${crf.created_by_id} has no workspace membership — skipping post-approval notification`,
    );
    return { failed: false };
  }
  const adminIds = await getMapAdminIds(workspaceId, crf.created_by_id);
  const recipientIds = [crf.created_by_id, ...adminIds];

  if (allInStock) {
    await safeNotifyCrfEvent({
      recipientIds,
      workspaceId,
      epcId: crf.epcId,
      title: "Ready to place your souvenir order",
      body: "Your CRF has been approved and all souvenir items are in stock. Place your order to proceed.",
      templateName: "crf-order-placed-prompt",
      templateData: { crfId: crf.id },
    });
    return { failed: false };
  }

  await safeNotifyCrfEvent({
    recipientIds,
    workspaceId,
    epcId: crf.epcId,
    title: "Souvenir stock shortfall",
    body: "Some souvenir items on your CRF are out of stock. Swap the affected lines, or place the order accepting the shortfall as a debit note.",
    templateName: "crf-stock-shortfall",
    templateData: { crfId: crf.id },
  });
  return { failed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// retryStockCheck — owner OR admin, STOCK_CHECK_FAILED only. A user-
// initiated re-run of the exact same check the approval hook already
// tried (runPostApprovalStockCheck), so "what counts as checked" has one
// implementation whether it's triggered by the system or by a person.
// Unlike the hook's own call, a failure here throws: this is a live
// request with someone waiting on the response, so "it failed again" is
// reported the normal way (502), not swallowed into a status flag.
// ─────────────────────────────────────────────────────────────────────────────

export async function retryStockCheck(actor: Actor, crfId: string) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner && !access.isAdmin) {
    throw new ApiError(
      403,
      "Only the CRF's creator or an administrator can retry the stock check",
    );
  }
  if (access.crf.status !== "STOCK_CHECK_FAILED") {
    throw new ApiError(
      409,
      `The stock check can only be retried while the CRF is STOCK_CHECK_FAILED (current status: ${access.crf.status})`,
    );
  }

  const result = await runPostApprovalStockCheck(crfId);
  if (result.failed) {
    throw new ApiError(
      502,
      "The stock check failed again — the souvenir store may still be unreachable",
    );
  }

  return { id: crfId };
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyMarketingOfCrfArtwork — forwards the CRF's Printed Material and
// Artwork line items to the marketing team's mailbox once the EPC is fully
// approved, so marketing can act on artwork/print requirements without
// needing MAP access. Souvenirs are deliberately excluded — those are
// Shopify-fulfilled and already covered by the stock-check/order flow
// above; this is strictly the catalog (non-Shopify) side of the CRF.
//
// The marketing mailbox is a fixed address (MARKETING_NOTIFY_EMAIL env
// var), not a MAP user, so this bypasses notify()/notifyCrfEvent (both
// assume an in-app recipient with a workspace membership) and calls
// addMailJob directly — the one place in this file that does so.
// ─────────────────────────────────────────────────────────────────────────────

async function notifyMarketingOfCrfArtwork(epcId: string): Promise<void> {
  const marketingEmail = process.env.MARKETING_NOTIFY_EMAIL;
  if (!marketingEmail) {
    logger.error(
      "[crfOrder.service] MARKETING_NOTIFY_EMAIL is not configured — skipping marketing forward",
    );
    return;
  }

  const crf = await prisma.cRF.findUnique({ where: { epcId } });
  if (!crf) return; // EPC has no CRF — nothing to forward

  const items = await prisma.crfItem.findMany({
    where: { crfId: crf.id, category: { in: ["PRINTED_MATERIAL", "ARTWORK"] } },
    include: { product: true },
    orderBy: { sortOrder: "asc" },
  });
  if (items.length === 0) return; // nothing for marketing to act on

  const subjectMeta = await getSubjectNotificationMeta("EVENT_PROPOSAL", epcId);
  const link = subjectMeta?.link ?? `/map/epc/${epcId}`;
  const subjectLabel = subjectMeta?.displayLabel ?? "CRF";

  await addMailJob({
    to: marketingEmail,
    subject: `Printed material & artwork — ${subjectLabel}`,
    templateName: "crf-artwork-marketing-forward",
    templateData: {
      epcId,
      subjectLabel,
      dashboardUrl: `${process.env.FRONTEND_URL ?? ""}${link}`,
      items: items.map((item) => ({
        category: item.category,
        name: item.product?.name ?? item.product?.partNumber ?? "—",
        quantity: item.quantity?.toString() ?? "—",
        width: item.width ?? null,
        height: item.height ?? null,
        unit: item.unit ?? null,
      })),
    },
  });
}

async function safeNotifyMarketingOfCrfArtwork(epcId: string): Promise<void> {
  try {
    await notifyMarketingOfCrfArtwork(epcId);
  } catch (error: any) {
    logger.error(
      `[crfOrder.service] Marketing artwork forward failed for EPC ${epcId}: ${error.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runEventProposalFinalApprovalHooks — the single entry point registered
// for EVENT_PROPOSAL in workflowSubject.helper.ts's postFinalApprovalHooks.
// Composes the two independent EPC-final-approval actions that live in
// this file: the souvenir stock check (above) and the marketing artwork
// forward (above). Run concurrently, and each already isolates its own
// failures internally (safeNotifyCrfEvent/markStockCheckFailed inside the
// stock check's own path; safeNotifyMarketingOfCrfArtwork here), so one
// failing can never block or hide a failure in the other.
//
// Returns { stockCheckFailed } — the one outcome of these two hooks that's
// user-actionable and worth surfacing as a toast on the approve response
// (workflow.service.ts's approveStage passes this straight through). The
// marketing forward's own success/failure is deliberately not surfaced the
// same way: it's an internal mailbox forward with no end-user action to
// take, so it stays a logged, silent best-effort exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

export async function runEventProposalFinalApprovalHooks(
  epcId: string,
): Promise<{ stockCheckFailed: boolean }> {
  const [stockCheckResult] = await Promise.all([
    runPostApprovalStockCheckForEpc(epcId),
    safeNotifyMarketingOfCrfArtwork(epcId),
  ]);

  return { stockCheckFailed: stockCheckResult.failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// swapSouvenirLines — owner-only, STOCK_SHORTFALL-only. Full replace of the
// souvenir lines (catalog lines untouched), re-checked against the frozen
// CRF.shortfallAmount — NOT souvenirTotalAtApproval. Charging against the
// shortfall value itself (rather than the whole approved total) and only
// for the portion that exceeds what was already kept is what keeps the
// budget from drifting as kept (in-stock) lines get re-priced live:
//
//   newSpend = Σ max(0, newQty(sku) − priorKeptQty(sku)) × currentPrice(sku)
//
// priorKeptQty is snapshotted BEFORE the old lines are wiped, from whatever
// was REQUESTED (i.e. in-stock, kept) going into this swap — so re-adding
// the same kept quantity back costs nothing extra, and only genuinely new
// or increased quantity counts against the shortfall budget.
//
// Two outcomes once the swap resolves:
//   - Still short: shortfallAmount is re-frozen to the new shortfall value.
//   - Fully resolved: any unused balance (budget − newSpend) is added to
//     CRF.pendingDebitAmount, to be folded into the eventual order's debit
//     note by executeOrderPlacement rather than lost.
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
    // Snapshot what was already kept (in-stock, REQUESTED) before the old
    // lines are wiped — this is the baseline that re-adding the same
    // quantity back costs nothing against.
    const priorKeptItems = await tx.crfItem.findMany({
      where: { crfId, category: "SOUVENIR", status: "REQUESTED" },
    });
    const priorKeptQtyBySku = new Map<string, number>();
    for (const item of priorKeptItems) {
      const sku = item.sku as string;
      priorKeptQtyBySku.set(
        sku,
        (priorKeptQtyBySku.get(sku) ?? 0) + (item.requestedQty ?? 0),
      );
    }

    await tx.crfItem.deleteMany({ where: { crfId, category: "SOUVENIR" } });

    const rows = buildShopifyItemRows(crfId, items);
    await tx.crfItem.createMany({ data: rows });

    const { allInStock, priceBySku, requestedBySku, shortfallValue } =
      await evaluateSouvenirStock(tx, crfId);

    let newSpend = 0;
    for (const [sku, qty] of requestedBySku) {
      const extraQty = Math.max(0, qty - (priorKeptQtyBySku.get(sku) ?? 0));
      newSpend += extraQty * (priceBySku.get(sku) ?? 0);
    }

    const budget = Number(access.crf.shortfallAmount ?? 0);
    if (budget > 0 && newSpend > budget) {
      throw new ApiError(
        400,
        `Swapped souvenir spend (₹${newSpend.toFixed(2)}) exceeds the shortfall budget (₹${budget.toFixed(2)})`,
      );
    }

    if (allInStock) {
      const leftover = budget - newSpend;
      const pendingDebitAmount =
        Number(access.crf.pendingDebitAmount ?? 0) +
        (leftover > 0 ? leftover : 0);
      await applyStockResultToCrf(tx, crfId, allInStock, {
        shortfallAmount: null,
        pendingDebitAmount,
      });
    } else {
      await applyStockResultToCrf(tx, crfId, allInStock, {
        shortfallAmount: shortfallValue,
      });
    }

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
//
// Any CRF.pendingDebitAmount left over from an earlier under-spent swap
// (see swapSouvenirLines) is folded into this order's debitNoteAmount
// here — whether or not this particular placement is itself accepting a
// partial shortfall — and cleared from the CRF, since it only ever exists
// to be billed at the next successful order placement.
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

  // Fold in any balance carried forward from an earlier under-spent swap
  // (see swapSouvenirLines) — independent of whether THIS placement is
  // itself accepting a partial shortfall.
  const pendingDebitAmount = Number(crf.pendingDebitAmount ?? 0);
  if (pendingDebitAmount > 0) {
    debitNoteAmount = (debitNoteAmount ?? 0) + pendingDebitAmount;
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

    await tx.cRF.update({
      where: { id: crf.id },
      data: { status: "ORDERED", pendingDebitAmount: null },
    });

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
    // shortItems.length > 0 means this debit note (at least partly) covers
    // items dropped from THIS order; otherwise, if there's still a nonzero
    // amount, it's entirely a carried-forward balance from an earlier swap.
    const debitNoteBody =
      debitNoteAmount !== undefined
        ? shortItems.length > 0
          ? `Your souvenir order has been placed. A debit note of ₹${debitNoteAmount.toFixed(2)} applies for the out-of-stock items.`
          : `Your souvenir order has been placed. A debit note of ₹${debitNoteAmount.toFixed(2)} applies, carried forward from an earlier swap.`
        : "Your souvenir order has been placed successfully.";

    await safeNotifyCrfEvent({
      recipientIds: [crf.created_by_id],
      workspaceId,
      epcId: crf.epcId,
      title: "Souvenir order placed",
      body: debitNoteBody,
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

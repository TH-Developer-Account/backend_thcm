/**
 * modules/map/crf.service.ts
 *
 * Service layer for CRF line items (printed material / artwork / souvenirs).
 * Pulled out of crf.controller.ts, which today embeds Prisma calls,
 * validation and ActivityLog writes directly in the controller, with the
 * same item-validation block copy-pasted between createCRF and updateCRF,
 * and with no ownership/status check on either — crf.routes.ts has no
 * authorize() calls at all, so this was wide open. This file is now the one
 * place that logic lives; the controller becomes a thin request/response
 * adapter over it.
 *
 * CrfItem unifies two very different kinds of line:
 *   - CATALOG (PRINTED_MATERIAL / ARTWORK / today's other non-souvenir
 *     categories) — same shape as the old LineItem: a ProductMaster row,
 *     quantity, rate, computed amount.
 *   - SHOPIFY (SOUVENIR) — sku + requestedQty, plus a client-supplied
 *     `amount` snapshot kept for audit only (what the line was worth at
 *     request time). No name, image, or live stock is ever stored here —
 *     that belongs to Shopify, not MAP — and `amount` is never recomputed
 *     from a live Shopify price or used in any budget/debit-note decision;
 *     those still re-check Shopify directly (see crfOrder.service.ts).
 *
 * Which shape an input item is follows from which fields it has
 * (`productId` → catalog, `sku` → shopify) rather than a client-supplied
 * `category`/`source` flag that would then need cross-checking against the
 * product it names — one source of truth (ProductMaster.category) instead
 * of two that could disagree.
 */

import { Prisma } from "../../../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  getCrfAccess,
  assertCrfAccess,
  computeCrfPermissions,
  EPC_EDITABLE_STATUSES,
} from "@map/crf/crfAccess.helper";

type Actor = AccessActor & { id: string };

// ─────────────────────────────────────────────────────────────────────────────
// Input shapes
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogCrfItemInput = {
  productId: string;
  quantity: number;
  width?: string;
  height?: string;
  unit?: string;
};

export type ShopifyCrfItemInput = {
  sku: string;
  requestedQty: number;
  /**
   * Client-computed line value (price × requestedQty) at request time.
   * Trusted as given — never re-derived from a fresh Shopify price lookup
   * here — and kept only as an audit/historical record of what the line
   * was worth when requested. Not used for souvenirTotalAtApproval, the
   * stock-shortfall budget cap, or the debit-note calculation, all of
   * which keep re-checking Shopify directly.
   */
  amount: number;
};

export type CrfItemInput = CatalogCrfItemInput | ShopifyCrfItemInput;

const isShopifyItemInput = (item: CrfItemInput): item is ShopifyCrfItemInput =>
  "sku" in item;

// ─────────────────────────────────────────────────────────────────────────────
// buildCrfItemRows — the one place that validates a raw item payload and
// turns it into CrfItem rows. Shared by createCrf and replaceCrfItems so the
// two can never drift the way createCRF/updateCRF's copy-pasted blocks did.
// ─────────────────────────────────────────────────────────────────────────────

async function buildCrfItemRows(
  tx: Prisma.TransactionClient,
  crfId: string,
  rawItems: CrfItemInput[],
): Promise<Prisma.CrfItemCreateManyInput[]> {
  if (!rawItems || rawItems.length === 0) {
    throw new ApiError(400, "Line items required");
  }

  const catalogInputs = rawItems.filter(
    (item): item is CatalogCrfItemInput => !isShopifyItemInput(item),
  );
  const shopifyInputs = rawItems.filter(isShopifyItemInput);

  const products = catalogInputs.length
    ? await tx.productMaster.findMany({
        where: { id: { in: catalogInputs.map((item) => item.productId) } },
      })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  const catalogRows: Prisma.CrfItemCreateManyInput[] = catalogInputs.map(
    (item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new ApiError(400, "Invalid product");
      if (product.productType !== "CRF") {
        throw new ApiError(400, "Invalid product for CRF");
      }
      // Souvenirs moved to Shopify — a stale SOUVENIR-category ProductMaster
      // row (from the old static seed data) can no longer be selected as a
      // catalog line, even though the row itself still exists.
      if (product.category === "SOUVENIR") {
        throw new ApiError(
          400,
          `${product.partNumber} is a souvenir — souvenirs are ordered by sku, not productId`,
        );
      }

      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ApiError(400, "quantity must be a positive number");
      }

      const rate = Number(product.unitRate ?? 0);
      const amount = quantity * rate;

      return {
        crfId,
        category: product.category,
        source: "CATALOG",
        productId: product.id,
        quantity,
        rate,
        amount,
        width: item.width,
        height: item.height,
        unit: item.unit,
      };
    },
  );

  const shopifyRows = buildShopifyItemRows(crfId, shopifyInputs);

  return [...catalogRows, ...shopifyRows];
}

// ─────────────────────────────────────────────────────────────────────────────
// buildShopifyItemRows — the sku/requestedQty/amount validation for souvenir
// lines, pulled out on its own (not just inlined in buildCrfItemRows above)
// because crfOrder.service.ts's shortfall-swap flow needs to replace *only*
// the souvenir lines of a CRF, independently of catalog lines. Both call
// sites go through this one validator rather than each re-implementing "sku
// required, requestedQty a positive whole number, amount a sane number".
//
// `amount` is trusted as given (no Shopify price re-check) — it is only ever
// a historical record of what the line was worth when requested, so the
// check here is a sanity bound (finite, non-negative), not a price lookup.
// ─────────────────────────────────────────────────────────────────────────────

export function buildShopifyItemRows(
  crfId: string,
  items: ShopifyCrfItemInput[],
): Prisma.CrfItemCreateManyInput[] {
  return items.map((item) => {
    const sku = item.sku?.trim();
    if (!sku) {
      throw new ApiError(400, "sku is required for a souvenir line");
    }

    const requestedQty = Number(item.requestedQty);
    if (!Number.isInteger(requestedQty) || requestedQty < 1) {
      throw new ApiError(
        400,
        "requestedQty must be a whole number >= 1 for a souvenir line",
      );
    }

    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ApiError(
        400,
        "amount must be a non-negative number for a souvenir line",
      );
    }

    return {
      crfId,
      category: "SOUVENIR" as const,
      source: "SHOPIFY" as const,
      sku,
      requestedQty,
      amount,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// assertEpcEditable — the EPC-level half of "can this CRF still be edited".
// EPC_EDITABLE_STATUSES was defined in crfAccess.helper.ts for exactly this
// check but never actually wired up anywhere — only the CRF's own status
// was being gated, which left a hole: a CRF in OPEN status could still be
// edited after its EPC moved past the stage where changes make sense.
// ─────────────────────────────────────────────────────────────────────────────

async function assertEpcEditable(
  tx: Prisma.TransactionClient,
  epcId: string,
): Promise<void> {
  const epc = await tx.eventProposal.findUnique({ where: { id: epcId } });
  if (!epc) throw new ApiError(404, "Event Proposal not found");

  const editableStatuses: readonly string[] = EPC_EDITABLE_STATUSES;
  if (!editableStatuses.includes(epc.status)) {
    throw new ApiError(
      409,
      `CRF items cannot be edited while the Event Proposal is in ${epc.status} status`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createCrf
// ─────────────────────────────────────────────────────────────────────────────

export async function createCrf(
  actor: Actor,
  epcId: string,
  rawItems: CrfItemInput[],
) {
  return prisma.$transaction(async (tx) => {
    await assertEpcEditable(tx, epcId);

    const existing = await tx.cRF.findUnique({ where: { epcId } });
    if (existing) throw new ApiError(400, "CRF already exists for this EPC");

    // crfNumber is intentionally left unset here — there is no agreed
    // generation rule yet for CRFs created after the migration (only a
    // one-time backfill rule for pre-existing rows). Flagged, not guessed.
    const crf = await tx.cRF.create({
      data: { epcId, created_by_id: actor.id },
    });

    const rows = await buildCrfItemRows(tx, crf.id, rawItems);
    await tx.crfItem.createMany({ data: rows });

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: epcId,
        actorId: actor.id,
        action: "CRF_CREATED",
        workflowId: null,
        stageId: null,
        metadata: { reason: "CRF created." },
      },
    });

    return crf;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// replaceCrfItems — full replace of a CRF's line items (today's updateCRF).
// Ownership and CRF-status are checked explicitly here rather than folded
// into a single boolean, because the two failure modes need different
// status codes: no relationship to this CRF at all is a 403 (assertCrfAccess
// below); having access but the CRF being in the wrong state to edit is a
// 409, matching the convention the THCM Shopify API itself uses for state
// conflicts.
// ─────────────────────────────────────────────────────────────────────────────

export async function replaceCrfItems(
  actor: Actor,
  crfId: string,
  rawItems: CrfItemInput[],
) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner) {
    throw new ApiError(403, "Only the CRF's creator can edit its line items");
  }
  if (access.crf.status !== "OPEN") {
    throw new ApiError(
      409,
      `CRF items can only be edited while the CRF is OPEN (current status: ${access.crf.status})`,
    );
  }

  return prisma.$transaction(async (tx) => {
    await assertEpcEditable(tx, access.crf.epcId);

    await tx.crfItem.deleteMany({ where: { crfId } });

    const rows = await buildCrfItemRows(tx, crfId, rawItems);
    await tx.crfItem.createMany({ data: rows });

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: access.crf.epcId,
        actorId: actor.id,
        action: "CRF_UPDATED",
        workflowId: null,
        stageId: null,
        metadata: { reason: "CRF items updated." },
      },
    });

    return { id: crfId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getCrfDetail — replaces getCRFById. Returns the CRF with its items,
// addresses and order, plus the computed permission flags, so the frontend
// never has to re-derive "can I edit this" from status/ownership itself.
// ─────────────────────────────────────────────────────────────────────────────

export async function getCrfDetail(actor: Actor, crfId: string) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  const crf = await prisma.cRF.findUnique({
    where: { id: crfId },
    include: {
      epc: true,
      items: {
        include: { product: true },
        orderBy: { sortOrder: "asc" },
      },
      // No separate `addresses` relation to include — the shipping address
      // is inlined directly onto CRF's own scalar fields (addressLine1,
      // addressCity, …), so it comes back automatically with the row.
      order: true,
    },
  });
  // access.crf already proved this row exists — a miss here would mean it
  // was deleted between the two reads, not a normal 404 case.
  if (!crf) throw new ApiError(404, "CRF not found");

  return {
    ...crf,
    permissions: computeCrfPermissions(access),
  };
}

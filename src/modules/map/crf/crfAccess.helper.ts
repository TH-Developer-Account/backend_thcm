/**
 * modules/map/crfAccess.helper.ts
 *
 * Every CRF service function calls getCrfAccess() first — there is no
 * authorize() middleware for CRF today (crf.routes.ts has none), so this
 * is the one place ownership/approver/admin rules live, instead of being
 * re-derived inline in each controller the way createCRF/updateCRF do today.
 *
 * "Owner" is CRF.created_by_id (backfilled from EventProposal.created_by_id
 * at migration time) rather than re-joining EventProposal on every check.
 */

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { isAppAdministrator } from "@rbac/profile/accessPolicy";
import type { AccessActor } from "@rbac/profile/access.types";
import type { CRF, CrfStatus } from "../../../prisma/generated/prisma/client";

// CONFIRM AGAINST epc.controller.ts: these are the EventProposal.status
// values a CRF's lines may still be fully edited under. "PENDING" is both
// the default (draft) status and the post-clarify reset status
// (clarifyResetStatus.EVENT_PROPOSAL). If EPC has a separate pre-submission
// draft status distinct from PENDING, add it here.
export const EPC_EDITABLE_STATUSES = ["PENDING"] as const;

export type CrfAccess = {
  crf: CRF;
  isOwner: boolean;
  isApprover: boolean;
  isAdmin: boolean;
};

export const getCrfAccess = async (
  actor: AccessActor & { id: string },
  crfId: string,
): Promise<CrfAccess> => {
  const crf = await prisma.cRF.findUnique({ where: { id: crfId } });
  if (!crf) throw new ApiError(404, "CRF not found");

  const isOwner = crf.created_by_id === actor.id;
  const isAdmin = isAppAdministrator(actor, "MAP");

  // Has an Approval row on the EPC's active workflow — same EXISTS pattern
  // as searchEventProposal.helper.ts, reused as a Prisma count query here
  // since we only need a boolean, not the row.
  const approverCount = isOwner
    ? 0 // short-circuit: owner check already answered isOwner, approver is irrelevant to most call sites when true
    : await prisma.approval.count({
        where: {
          approverId: actor.id,
          stage: {
            workflow: {
              subjectType: "EVENT_PROPOSAL",
              subjectId: crf.epcId,
              isActive: true,
            },
          },
        },
      });

  return { crf, isOwner, isApprover: approverCount > 0, isAdmin };
};

export const assertCrfAccess = (access: CrfAccess): void => {
  if (!access.isOwner && !access.isApprover && !access.isAdmin) {
    throw new ApiError(403, "You do not have access to this CRF");
  }
};

/**
 * computeCrfPermissions — the single source of truth for "who can do what,
 * when" on a CRF. GET /crf/:crfId returns this on the response so the
 * frontend never re-derives these rules; every mutating service function
 * also calls the relevant flag itself before writing, rather than trusting
 * the frontend to have hidden the button.
 */
export type CrfPermissions = {
  canEditLines: boolean; // full line replace — OPEN only, owner
  canSwapSouvenirLines: boolean; // souvenir-only edit — STOCK_SHORTFALL, owner
  canEditDispatchDetails: boolean; // recipient + addresses — APPROVED/STOCK_SHORTFALL/ORDER_FAILED, owner
  canPlaceOrder: boolean; // APPROVED/STOCK_SHORTFALL, owner
  canRetryOrder: boolean; // ORDER_FAILED — owner or admin
  canCancelOrder: boolean; // ORDERED — owner or admin
  // DEFERRED — manual PM/ARTWORK lines — owner or admin, once APPROVED or
  // later. The schema already carries CrfItem.deliveredAt/deliveredById and
  // CrfItemStatus.REMOVED for this, and this flag is computed below, but
  // there is no endpoint behind it yet (no markItemDelivered/removeItem
  // service function or route). Deliberately left as a known future
  // increment rather than built or ripped out — see the Oct 2026 Shopify
  // integration build notes.
  canMarkItemDelivered: boolean;
  canView: boolean;
};

export const DISPATCH_EDITABLE_STATUSES: CrfStatus[] = [
  "APPROVED",
  "STOCK_SHORTFALL",
  "ORDER_FAILED",
];

export const computeCrfPermissions = (access: CrfAccess): CrfPermissions => {
  const { crf, isOwner, isAdmin } = access;
  const ownerOrAdmin = isOwner || isAdmin;

  return {
    canEditLines:
      isOwner &&
      crf.status === "OPEN" &&
      // EPC-level editability is checked separately in the service (it
      // needs the EPC row, which this helper doesn't load) — this flag
      // only reflects the CRF's own status.
      true,
    canSwapSouvenirLines: isOwner && crf.status === "STOCK_SHORTFALL",
    canEditDispatchDetails:
      isOwner && DISPATCH_EDITABLE_STATUSES.includes(crf.status),
    canPlaceOrder:
      isOwner &&
      (crf.status === "APPROVED" || crf.status === "STOCK_SHORTFALL"),
    canRetryOrder: ownerOrAdmin && crf.status === "ORDER_FAILED",
    canCancelOrder: ownerOrAdmin && crf.status === "ORDERED",
    canMarkItemDelivered:
      ownerOrAdmin && !["OPEN", "CANCELLED"].includes(crf.status),
    canView: true, // getCrfAccess callers already asserted access before reaching here
  };
};

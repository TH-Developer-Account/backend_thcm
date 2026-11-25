// handouts/handoutsAccess.helper.ts
//
// Mirrors modules/map/crf/crfAccess.helper.ts. The one structural difference:
// CRF resolves "am I the approver?" from a dynamic workflow/Approval chain
// because EPC approval routing is configurable. Handouts has a single fixed
// approval stage with exactly one approver and one delivery person, each a
// specific User id configured in the environment (see
// handoutStatus.constants.ts) — not an RBAC-resolved group, and NOT
// overridable by an app administrator: the two roles are meant to stay
// strictly separate (an approver only approves/rejects/clarifies, a
// delivery person only fulfils), so isAdmin never feeds isApprover or
// isDeliveryTeam. HANDOUT_MODULE write access is checked separately, at the
// route level in handouts.routes.ts: it gates who can touch the Handouts
// API at all (raise/cancel/resubmit a request), not who the approver or
// delivery person is. isAdmin still grants view access (assertHandoutAccess,
// canView below) so an admin can look up any request for support, but it
// grants no act-as-approver or act-as-deliverer capability.

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { isAppAdministrator } from "@rbac/profile/accessPolicy";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  HANDOUT_APP,
  HANDOUT_APPROVER_USER_ID,
  HANDOUT_DELIVERY_USER_ID,
  HANDOUT_STATUS,
  type HandoutStatus,
} from "./handoutStatus.constants";

export type Actor = AccessActor & { id: string };

const loadHandout = (handoutId: string) =>
  prisma.handoutRequest.findUnique({
    where: { id: handoutId },
    include: {
      items: true,
      order: true,
      // User has no `name` column (first_name/last_name only) and
      // `designation` is a relation (Designation?), not a plain string —
      // both selected accordingly and assembled into display strings by
      // the callers that need them (handouts.services.ts).
      requestedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          department: true,
          designation: { select: { name: true } },
        },
      },
      deliveredBy: { select: { id: true, first_name: true, last_name: true } },
    },
  });

export type HandoutAccess = {
  handout: NonNullable<Awaited<ReturnType<typeof loadHandout>>>;
  isOwner: boolean;
  isApprover: boolean;
  isDeliveryTeam: boolean;
  isAdmin: boolean;
};

export const getHandoutAccess = async (
  actor: Actor,
  handoutId: string,
): Promise<HandoutAccess> => {
  const handout = await loadHandout(handoutId);
  if (!handout) throw new ApiError(404, "Handout request not found");

  const isOwner = handout.requestedById === actor.id;
  const isAdmin = isAppAdministrator(actor, HANDOUT_APP);

  // Two fixed, distinct individuals — see the file header. Deliberately NOT
  // `|| isAdmin`: an app administrator can still view the request (isAdmin
  // feeds assertHandoutAccess and canView below) but must not be able to
  // act as the approver or the delivery person just by being an admin —
  // the two roles stay strictly separate.
  const isApprover = actor.id === HANDOUT_APPROVER_USER_ID;
  const isDeliveryTeam = actor.id === HANDOUT_DELIVERY_USER_ID;

  return { handout, isOwner, isApprover, isDeliveryTeam, isAdmin };
};

export const assertHandoutAccess = (access: HandoutAccess): void => {
  if (
    !access.isOwner &&
    !access.isApprover &&
    !access.isDeliveryTeam &&
    !access.isAdmin
  ) {
    throw new ApiError(403, "You do not have access to this handout request");
  }
};

export type HandoutPermissions = {
  canView: boolean;
  canCancel: boolean;
  canApprove: boolean;
  canReject: boolean;
  canDeliver: boolean;
  canClarify: boolean;
  canResubmit: boolean;
  canCannotFulfil: boolean;
};

// Pure function — status + role flags in, booleans out. This is the single
// source of truth for what the UI shows; nothing in the frontend re-derives
// button visibility from status strings.
export const computeHandoutPermissions = (
  access: HandoutAccess,
): HandoutPermissions => {
  const { handout, isOwner, isApprover, isDeliveryTeam } = access;
  const status = handout.status as HandoutStatus;
  const isPending = status === HANDOUT_STATUS.PENDING_APPROVAL;

  return {
    canView:
      access.isOwner ||
      access.isApprover ||
      access.isDeliveryTeam ||
      access.isAdmin,
    canCancel:
      isOwner &&
      (status === HANDOUT_STATUS.PENDING_APPROVAL ||
        status === HANDOUT_STATUS.CLARIFICATION_REQUESTED),
    canApprove: isApprover && isPending,
    canReject: isApprover && isPending,
    // Approver's third option alongside approve/reject — see chat notes:
    // this corrects a stale doc-comment in handouts.types.ts that had it
    // as a requester/CLARIFICATION_REQUESTED action.
    canClarify: isApprover && isPending,
    // Requester acting on an approver's clarification request.
    canResubmit: isOwner && status === HANDOUT_STATUS.CLARIFICATION_REQUESTED,
    canDeliver: isDeliveryTeam && status === HANDOUT_STATUS.APPROVED,
    // Manual, post-approval "turns out we can't fulfil this" — distinct
    // from the automatic transition approveHandout() makes on a stock
    // shortfall, which never reaches APPROVED in the first place.
    canCannotFulfil: isDeliveryTeam && status === HANDOUT_STATUS.APPROVED,
  };
};

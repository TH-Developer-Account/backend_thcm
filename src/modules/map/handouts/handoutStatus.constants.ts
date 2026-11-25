// handouts/handoutStatus.constants.ts
//
// HandoutStatus and HandoutFulfillmentType are plain Prisma `String` columns,
// not enums — a new status/fulfillment type is a code change + deploy, never
// a migration. This file is the single source of truth for the allowed
// values; services validate against it, the Prisma column just stores
// whatever string lands here.
//
// Keep in lockstep with the frontend's handouts.types.ts HandoutStatus union
// — same literal strings, same order, so the two never silently drift.

import logger from "@shared/utils/logger";

export const HANDOUT_STATUS = {
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  CLOSED: "CLOSED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  CANNOT_FULFIL: "CANNOT_FULFIL",
} as const;

export type HandoutStatus =
  (typeof HANDOUT_STATUS)[keyof typeof HANDOUT_STATUS];

export const HANDOUT_STATUS_VALUES = Object.values(HANDOUT_STATUS);

export const isHandoutStatus = (value: string): value is HandoutStatus =>
  (HANDOUT_STATUS_VALUES as string[]).includes(value);

export const HANDOUT_FULFILLMENT_TYPE = {
  HAND_DELIVERY: "HAND_DELIVERY",
  SHIPPED: "SHIPPED",
} as const;

export type HandoutFulfillmentType =
  (typeof HANDOUT_FULFILLMENT_TYPE)[keyof typeof HANDOUT_FULFILLMENT_TYPE];

export const HANDOUT_FULFILLMENT_TYPE_VALUES = Object.values(
  HANDOUT_FULFILLMENT_TYPE,
);

export const isHandoutFulfillmentType = (
  value: string,
): value is HandoutFulfillmentType =>
  (HANDOUT_FULFILLMENT_TYPE_VALUES as string[]).includes(value);

// Placeholder pickup address for HAND_DELIVERY orders (Shopify still needs
// *some* shippingAddress on createOrder). Fazal: swap this for the real
// depot/office address once you have it — single edit point.
export const HANDOUT_PLACEHOLDER_PICKUP_ADDRESS = {
  address1: "Tata Hitachi Construction Machinery — Marketing Dept",
  city: "Bengaluru",
  province: "Karnataka",
  zip: "560001",
  country: "India",
  phone: "0000000000",
} as const;

// Valid forward transitions, keyed by current status. Single source of
// truth for the status machine — every decision service checks against
// this instead of re-deriving "is this transition legal" ad hoc.
export const HANDOUT_STATUS_TRANSITIONS: Record<
  HandoutStatus,
  HandoutStatus[]
> = {
  PENDING_APPROVAL: [
    HANDOUT_STATUS.APPROVED,
    HANDOUT_STATUS.REJECTED,
    HANDOUT_STATUS.CLARIFICATION_REQUESTED,
    HANDOUT_STATUS.CANNOT_FULFIL, // automatic, on a stock shortfall at approve-time
    HANDOUT_STATUS.CANCELLED,
  ],
  CLARIFICATION_REQUESTED: [
    HANDOUT_STATUS.PENDING_APPROVAL, // resubmit
    HANDOUT_STATUS.CANCELLED,
  ],
  APPROVED: [
    HANDOUT_STATUS.CLOSED, // deliver
    HANDOUT_STATUS.CANNOT_FULFIL, // manual, delivery team
  ],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
  CANNOT_FULFIL: [],
};

export const assertValidHandoutTransition = (
  from: HandoutStatus,
  to: HandoutStatus,
): void => {
  if (!HANDOUT_STATUS_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal handout status transition: ${from} -> ${to}`);
  }
};

// ── Backend-side copies of the RBAC/limit constants ─────────────────────────
// handouts.constants.ts (HANDOUT_APP, HANDOUT_MODULE, HANDOUT_LIMITS,
// HANDOUTS_BASE_PATH) is a frontend-only file and is not reachable from the
// backend's compile — same reason crf-shop.routes.ts hardcodes
// authorize("MAP", "CRF", "read") as literal strings instead of importing a
// shared constants file. These are duplicated here, not imported, as the
// backend's own source of truth. Keep the values in lockstep with the
// frontend file by hand if either side ever changes.

export const HANDOUT_APP = "MAP";

// Single RBAC module for the whole feature: read = view, write = raise,
// approve AND deliver — requester/approver/delivery-team are not separately
// grantable. See handoutsAccess.helper.ts for how row-level actions still
// narrow by status once someone holds this one write grant.
export const HANDOUT_MODULE = "HANDOUT";

export const HANDOUT_LIMITS = {
  PURPOSE: 200,
  DELIVER_TO: 200,
  REMARKS: 500,
  NOTE: 500,
  MAX_ITEMS: 50,
} as const;

export const HANDOUTS_BASE_PATH = "/marketing/activity-planner/handouts";

// ── Fixed approver / delivery-person identity ───────────────────────────────
// Handouts has exactly one approver and one delivery person — not a dynamic
// RBAC-resolved group (see handoutsAccess.helper.ts). These come from the
// environment, never a literal User id in source: the same person has a
// different `User.id` in every environment's database (dev/staging/prod),
// so a hardcoded id here would be silently wrong everywhere but the one
// environment it was copied from. HANDOUT_MODULE above still gates "can
// touch the Handouts API at all" (raise/cancel/resubmit); it is not what
// makes someone the approver or the delivery person.
export const HANDOUT_APPROVER_USER_ID =
  process.env.HANDOUT_APPROVER_USER_ID ?? "";
export const HANDOUT_DELIVERY_USER_ID =
  process.env.HANDOUT_DELIVERY_USER_ID ?? "";

if (!HANDOUT_APPROVER_USER_ID || !HANDOUT_DELIVERY_USER_ID) {
  logger.error(
    "[handoutStatus.constants] HANDOUT_APPROVER_USER_ID and/or HANDOUT_DELIVERY_USER_ID are not set — no one will be able to approve or deliver handout requests until both are configured in the environment.",
  );
}

// handouts/handouts.services.ts
//
// CRUD / read-side for Handouts: create, list (role-scoped views), detail,
// resubmit. Decision actions (approve/reject/clarify/cancel/cannot-fulfil/
// deliver) live in handoutsDecision.services.ts — same split CRF uses
// between crf.services.ts and crf-order.services.ts.
//
// ✅ CHANGED — createHandout now assigns a real WorkflowInstance (via the
// generic kernel/workflow engine's assignWorkflow) instead of leaving
// Handouts with no workflow at all. listHandouts' `view=approve` scoping
// moves off the fixed HANDOUT_APPROVER_USER_ID identity onto the same
// "is this actor a pending approver on an active Handout workflow" check
// handoutsAccess.helper.ts now uses for isApprover.

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
// NOTE: same path-alias uncertainty flagged elsewhere in this pass — every
// other import in this file is relative. Adjust to your real tsconfig
// mapping for kernel/workflow.
import {
  assignWorkflow,
  notifyStageApprovers,
} from "@kernel/workflow/workflow.service";
import {
  HANDOUT_APP,
  HANDOUT_STATUS,
  HANDOUT_FULFILLMENT_TYPE,
  HANDOUT_LIMITS,
  HANDOUT_DELIVERY_USER_ID,
  isHandoutFulfillmentType,
  assertValidHandoutTransition,
} from "./handoutStatus.constants";
import {
  getHandoutAccess,
  assertHandoutAccess,
  computeHandoutPermissions,
  getActiveHandoutStage,
  type Actor,
} from "./handoutsAccess.helper";
import {
  safeNotifyHandoutEvent,
  getOwnerWorkspaceId,
} from "./handoutsNotify.helper";

// ActivityLog is written directly, the same way every call site in
// crfOrder.services.ts does it — there is no logActivity() wrapper in this
// codebase.

// ── Request-number generation ───────────────────────────────────────────────
// Mirrors epcNumber.ts exactly: pure application-code composition of
// prefix + timestamp-to-the-second, no DB sequence/counter table. Same tiny
// theoretical collision window EPC already accepts — handled with a single
// retry on the unique-constraint violation rather than any locking.
const generateHandoutRequestNumber = (): string => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const time = now
    .toLocaleTimeString("en-GB", { hour12: false })
    .replace(/:/g, "");
  return `HO/${yyyy}${mm}${dd}${time}`;
};

const PRISMA_UNIQUE_CONSTRAINT_CODE = "P2002";

// ── Create ───────────────────────────────────────────────────────────────────

export type CreateHandoutInput = {
  purpose: string;
  requiredBy: string; // yyyy-mm-dd
  fulfillmentType: "HAND_DELIVERY" | "SHIPPED";
  deliverTo: string;
  contactPhone: string;
  remarks?: string;
  items: Array<{
    sku: string;
    quantity: number;
    title?: string;
    variantTitle?: string;
    imageUrl?: string;
    rate: number;
  }>;
  // Only required/used when fulfillmentType === "SHIPPED" — the exact same
  // field set as CRF's address columns (addressLine1/Line2/Landmark/City/
  // District/State/Pincode/Country/Gstin on both CRF and HandoutRequest).
  shippingAddress?: {
    line1: string;
    line2?: string;
    landmark?: string;
    city: string;
    district?: string;
    state: string;
    pincode: string;
    country?: string;
    gstin?: string;
  };
};

const validateCreateInput = (input: CreateHandoutInput): void => {
  if (!input.purpose?.trim()) throw new ApiError(400, "Purpose is required");
  if (input.purpose.length > HANDOUT_LIMITS.PURPOSE) {
    throw new ApiError(
      400,
      `Purpose must be ${HANDOUT_LIMITS.PURPOSE} characters or fewer`,
    );
  }
  if (!input.deliverTo?.trim())
    throw new ApiError(400, "Deliver-to location is required");
  if (input.deliverTo.length > HANDOUT_LIMITS.DELIVER_TO) {
    throw new ApiError(
      400,
      `Deliver-to must be ${HANDOUT_LIMITS.DELIVER_TO} characters or fewer`,
    );
  }
  if (!input.contactPhone?.trim())
    throw new ApiError(400, "Contact phone is required");
  if (input.remarks && input.remarks.length > HANDOUT_LIMITS.REMARKS) {
    throw new ApiError(
      400,
      `Remarks must be ${HANDOUT_LIMITS.REMARKS} characters or fewer`,
    );
  }
  if (!isHandoutFulfillmentType(input.fulfillmentType)) {
    throw new ApiError(
      400,
      `Invalid fulfillment type: ${input.fulfillmentType}`,
    );
  }
  if (
    input.fulfillmentType === HANDOUT_FULFILLMENT_TYPE.SHIPPED &&
    !input.shippingAddress
  ) {
    throw new ApiError(
      400,
      "Shipping address is required for shipped handouts",
    );
  }
  if (!input.items?.length)
    throw new ApiError(400, "At least one item is required");
  if (input.items.length > HANDOUT_LIMITS.MAX_ITEMS) {
    throw new ApiError(
      400,
      `A handout request may have at most ${HANDOUT_LIMITS.MAX_ITEMS} items`,
    );
  }
  for (const item of input.items) {
    if (!item.sku?.trim()) throw new ApiError(400, "Every item requires a SKU");
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ApiError(400, `Invalid quantity for ${item.sku}`);
    }
    if (typeof item.rate !== "number" || item.rate < 0) {
      throw new ApiError(400, `Invalid rate for ${item.sku}`);
    }
  }
};

export const createHandout = async (
  actor: Actor,
  input: CreateHandoutInput,
) => {
  validateCreateInput(input);

  // Resolved once, up front: both the workspace (assignWorkflow needs it)
  // and the Handout app's own row id (assignWorkflow's `appId` — distinct
  // from the HANDOUT_APP *key* string everything else in this module uses).
  // No dedicated resolver exists for "App id by key" anywhere else in this
  // codebase (crf-shop.routes.ts and this module both only ever use the
  // key as a literal for RBAC calls, never the row id) — a one-off lookup
  // here, not a new shared abstraction, per KISS: there is exactly one
  // call site that needs it.
  const [workspaceId, handoutApp] = await Promise.all([
    getOwnerWorkspaceId(actor.id),
    prisma.app.findUniqueOrThrow({
      where: { key: HANDOUT_APP },
      select: { id: true },
    }),
  ]);
  if (!workspaceId) {
    throw new ApiError(
      409,
      "Your account has no workspace membership — required to raise a handout request",
    );
  }

  const attempt = async (retried: boolean): Promise<string> => {
    const requestNumber = generateHandoutRequestNumber();
    try {
      // Create + workflow assignment in one transaction: a HandoutRequest
      // row that exists with no WorkflowInstance behind it would have no
      // approver at all (getHandoutAccess's isApprover resolves purely
      // from the active workflow's current stage) — an inconsistent state
      // worth paying one extra statement to make impossible, rather than
      // the two-step "create, then assign" pattern the vendor-onboarding
      // frontend uses for its own, multi-screen submission flow. Handout
      // creation is a single backend call, so there's no equivalent
      // intermediate screen that needs the record to exist before the
      // workflow is ready.
      const { handout } = await prisma.$transaction(async (tx) => {
        const created = await tx.handoutRequest.create({
          data: {
            requestNumber,
            purpose: input.purpose.trim(),
            requiredBy: new Date(input.requiredBy),
            fulfillmentType: input.fulfillmentType,
            deliverTo: input.deliverTo.trim(),
            contactPhone: input.contactPhone.trim(),
            remarks: input.remarks?.trim() || null,
            status: HANDOUT_STATUS.PENDING_APPROVAL,
            requestedById: actor.id,
            addressLine1: input.shippingAddress?.line1,
            addressLine2: input.shippingAddress?.line2,
            addressLandmark: input.shippingAddress?.landmark,
            addressCity: input.shippingAddress?.city,
            addressDistrict: input.shippingAddress?.district,
            addressState: input.shippingAddress?.state,
            addressPincode: input.shippingAddress?.pincode,
            addressCountry: input.shippingAddress?.country ?? "India",
            addressGstin: input.shippingAddress?.gstin,
            items: {
              // No `amount` column on HandoutItem — quantity × rate is
              // computed on read (getHandoutDetail), never stored.
              create: input.items.map((item) => ({
                sku: item.sku,
                quantity: item.quantity,
                title: item.title ?? item.sku,
                variantTitle: item.variantTitle ?? null,
                imageUrl: item.imageUrl ?? null,
                rate: item.rate,
              })),
            },
          },
        });

        await assignWorkflow(tx, {
          subjectType: "HANDOUT_REQUEST",
          subjectId: created.id,
          workspaceId,
          appId: handoutApp.id,
          userId: actor.id,
        });

        return { handout: created };
      });

      return handout.id;
    } catch (error: any) {
      // Collision on the requestNumber unique constraint (two requests
      // generated in the same second) — same acceptance EPC makes:
      // retry exactly once with a fresh timestamp, never loop forever.
      if (!retried && error?.code === PRISMA_UNIQUE_CONSTRAINT_CODE) {
        return attempt(true);
      }
      throw error;
    }
  };

  const handoutId = await attempt(false);

  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "SUBMITTED",
      workflowId: null,
      stageId: null,
    },
  });

  // Approver notification now goes through the generic engine's own
  // notifyStageApprovers — same call every other subject type's
  // assignment uses — rather than Handout's own safeNotifyHandoutEvent
  // SUBMITTED event, which this replaces (see handoutsNotify.helper.ts;
  // the SUBMITTED event/copy has been removed there as now-dead code).
  // Re-reading the stage here rather than threading it out of the
  // transaction above keeps this one extra read outside the transaction,
  // consistent with "notifications are always post-commit."
  const { workflow, stage } = await getActiveHandoutStage(handoutId);
  if (workflow && stage) {
    await notifyStageApprovers({
      workflowId: workflow.id,
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      appId: handoutApp.id,
      stageId: stage.id,
      approverIds: stage.approvals.map((a) => a.approverId),
    });
  }

  return getHandoutDetail(actor, handoutId);
};

// ── List ─────────────────────────────────────────────────────────────────────

export type ListHandoutsInput = {
  view: "mine" | "approve" | "deliver";
  status?: string;
  search?: string;
  page: number;
  pageSize: number;
};

export const listHandouts = async (actor: Actor, params: ListHandoutsInput) => {
  const where: any = {};

  // The view decides the base scope. HANDOUT_MODULE write access (checked
  // at the route level via authorize()) only gates "can touch the Handouts
  // API at all" — it says nothing about *which* person the approver or
  // delivery person is (see handoutsAccess.helper.ts). So "approve" and
  // "deliver" must also be scoped to whoever actually holds that role, or
  // anyone with write access would see every pending/approved request in
  // the system, not just the ones actually waiting on them.
  if (params.view === "mine") {
    where.requestedById = actor.id;
  } else if (params.view === "approve") {
    // ✅ CHANGED — was a fixed HANDOUT_APPROVER_USER_ID identity check.
    // "Approver" is now whoever is a PENDING approver on any currently
    // active, IN_PROGRESS Handout workflow stage — resolved once here
    // rather than per-row, since Handouts' single-template/single-stage
    // setup means this is the same small approver set across every
    // pending request today, not a per-request lookup.
    const isCurrentApprover = await prisma.workflowInstance.findFirst({
      where: {
        subjectType: "HANDOUT_REQUEST",
        isActive: true,
        stages: {
          some: {
            isCurrentIteration: true,
            status: "IN_PROGRESS",
            approvals: { some: { approverId: actor.id, status: "PENDING" } },
          },
        },
      },
      select: { id: true },
    });
    if (!isCurrentApprover) {
      throw new ApiError(403, "You are not a current handout approver");
    }
    where.status = HANDOUT_STATUS.PENDING_APPROVAL;
  } else if (params.view === "deliver") {
    if (actor.id !== HANDOUT_DELIVERY_USER_ID) {
      throw new ApiError(
        403,
        "You are not the configured handout delivery person",
      );
    }
    where.status = HANDOUT_STATUS.APPROVED;
  }

  if (params.status) {
    where.status = params.status; // explicit status filter narrows further, any view
  }
  if (params.search?.trim()) {
    where.OR = [
      {
        requestNumber: { contains: params.search.trim(), mode: "insensitive" },
      },
      { purpose: { contains: params.search.trim(), mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.handoutRequest.findMany({
      where,
      include: {
        items: true,
        requestedBy: { select: { first_name: true, last_name: true } },
      },
      // HandoutRequest uses snake_case created_at/updated_at (unlike
      // ActivityLog, which is camelCase createdAt) — ordering and every
      // read below go against the real column name.
      orderBy: { created_at: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.handoutRequest.count({ where }),
  ]);

  return {
    items: rows.map((handout) => ({
      id: handout.id,
      requestNumber: handout.requestNumber,
      purpose: handout.purpose,
      status: handout.status,
      requiredBy: handout.requiredBy.toISOString().slice(0, 10),
      // Wire contract field is camelCase `createdAt` — only the source
      // column (handout.created_at) is snake_case.
      createdAt: handout.created_at.toISOString(),
      requestedByName:
        `${handout.requestedBy.first_name} ${handout.requestedBy.last_name}`.trim(),
      itemCount: handout.items.length,
      totalQuantity: handout.items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      ),
    })),
    total,
  };
};

// ── Detail ───────────────────────────────────────────────────────────────────

export const getHandoutDetail = async (actor: Actor, handoutId: string) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);

  const { handout } = access;
  const permissions = computeHandoutPermissions(access);

  const timeline = await prisma.activityLog.findMany({
    where: { subjectType: "HANDOUT_REQUEST", subjectId: handoutId },
    orderBy: { createdAt: "asc" },
    include: { actor: { select: { first_name: true, last_name: true } } },
  });

  return {
    id: handout.id,
    requestNumber: handout.requestNumber,
    purpose: handout.purpose,
    status: handout.status,
    requiredBy: handout.requiredBy.toISOString().slice(0, 10),
    createdAt: handout.created_at.toISOString(),
    requestedByName:
      `${handout.requestedBy.first_name} ${handout.requestedBy.last_name}`.trim(),
    requestedByDesignation: handout.requestedBy.designation?.name ?? null,
    requestedByDepartment: handout.requestedBy.department ?? null,
    itemCount: handout.items.length,
    totalQuantity: handout.items.reduce((sum, item) => sum + item.quantity, 0),
    deliverTo: handout.deliverTo,
    contactPhone: handout.contactPhone,
    remarks: handout.remarks,
    // No `amount` column on HandoutItem — quantity × rate computed here,
    // the only place this request's line totals are derived.
    items: handout.items.map((item) => ({
      id: item.id,
      sku: item.sku,
      title: item.title,
      variantTitle: item.variantTitle,
      imageUrl: item.imageUrl,
      quantity: item.quantity,
      rate: Number(item.rate ?? 0),
      amount: item.quantity * Number(item.rate ?? 0),
    })),
    totalAmount: handout.items.reduce(
      (sum, item) => sum + item.quantity * Number(item.rate ?? 0),
      0,
    ),
    timeline: timeline.map((entry) => ({
      id: entry.id,
      action: entry.action,
      byName: entry.actor
        ? `${entry.actor.first_name} ${entry.actor.last_name}`.trim()
        : "System",
      at: entry.createdAt.toISOString(),
      comment: (entry.metadata as any)?.comment ?? null,
    })),
    // Set once THCM's tracking webhook has fired for a SHIPPED handout
    // (see handoutsTracking.services.ts's recordHandoutShopifyTracking) —
    // null for HAND_DELIVERY handouts, and null for SHIPPED ones until the
    // callback arrives. Surfacing this is the only thing that webhook
    // does; it never changes `delivery` below — that stays a manual,
    // delivery-team-only action regardless of what Shopify reports.
    tracking: handout.order?.trackingNumber
      ? {
          trackingNumber: handout.order.trackingNumber,
          trackingUrl: handout.order.trackingUrl!,
        }
      : null,
    // Delivery fields live directly on HandoutRequest, not on HandoutOrder
    // (HandoutOrder only holds the Shopify order snapshot: shopifyOrderId/
    // totalPrice/lines, plus now trackingNumber/trackingUrl/
    // trackingUpdatedAt).
    delivery: handout.deliveredOn
      ? {
          handedToName: handout.handedToName!,
          deliveredOn: handout.deliveredOn.toISOString(),
          note: handout.deliveryNote,
          deliveredByName: handout.deliveredBy
            ? `${handout.deliveredBy.first_name} ${handout.deliveredBy.last_name}`.trim()
            : "—",
        }
      : null,
    rejectionReason: handout.rejectionReason,
    permissions,
  };
};

// ── Resubmit ─────────────────────────────────────────────────────────────────
// CLARIFICATION_REQUESTED -> PENDING_APPROVAL. Same body shape as create();
// a full replace, not a partial patch, since the requester is expected to
// have addressed whatever the approver asked about.
//
// UNCHANGED — resubmit stays a Handout-specific status flip and never
// touches the WorkflowInstance (see handoutsDecision.services.ts's file
// header): the same single stage that was assigned at creation time is
// still sitting there IN_PROGRESS the whole time a handout is in
// CLARIFICATION_REQUESTED, ready for the same approver to act on it again
// once resubmitted — there is no "next iteration" to build.

export const resubmitHandout = async (
  actor: Actor,
  handoutId: string,
  input: CreateHandoutInput,
) => {
  const access = await getHandoutAccess(actor, handoutId);
  assertHandoutAccess(access);

  if (!access.isOwner) {
    throw new ApiError(403, "Only the requester can resubmit this handout");
  }
  assertValidHandoutTransition(
    access.handout.status as any,
    HANDOUT_STATUS.PENDING_APPROVAL,
  );

  validateCreateInput(input);

  await prisma.$transaction(async (tx) => {
    await tx.handoutItem.deleteMany({ where: { handoutId } });
    await tx.handoutRequest.update({
      where: { id: handoutId },
      data: {
        purpose: input.purpose.trim(),
        requiredBy: new Date(input.requiredBy),
        fulfillmentType: input.fulfillmentType,
        deliverTo: input.deliverTo.trim(),
        contactPhone: input.contactPhone.trim(),
        remarks: input.remarks?.trim() || null,
        status: HANDOUT_STATUS.PENDING_APPROVAL,
        addressLine1: input.shippingAddress?.line1,
        addressLine2: input.shippingAddress?.line2,
        addressLandmark: input.shippingAddress?.landmark,
        addressCity: input.shippingAddress?.city,
        addressDistrict: input.shippingAddress?.district,
        addressState: input.shippingAddress?.state,
        addressPincode: input.shippingAddress?.pincode,
        addressCountry: input.shippingAddress?.country ?? "India",
        addressGstin: input.shippingAddress?.gstin,
        items: {
          create: input.items.map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
            title: item.title ?? item.sku,
            variantTitle: item.variantTitle ?? null,
            imageUrl: item.imageUrl ?? null,
            rate: item.rate,
          })),
        },
      },
    });
  });

  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "SUBMITTED",
      workflowId: null,
      stageId: null,
    },
  });
  await safeNotifyHandoutEvent({ handoutId, event: "RESUBMITTED", actor });

  return getHandoutDetail(actor, handoutId);
};

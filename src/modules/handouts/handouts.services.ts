// handouts/handouts.services.ts
//
// CRUD / read-side for Handouts: create, list (role-scoped views), detail,
// resubmit. Decision actions (approve/reject/clarify/cancel/cannot-fulfil/
// deliver) live in handoutsDecision.services.ts — same split CRF uses
// between crf.services.ts and crf-order.services.ts.

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  HANDOUT_STATUS,
  HANDOUT_FULFILLMENT_TYPE,
  HANDOUT_LIMITS,
  HANDOUT_APP,
  HANDOUT_DELIVERY_USER_ID,
  isHandoutFulfillmentType,
  assertValidHandoutTransition,
} from "./handoutStatus.constants";
import {
  getHandoutAccess,
  assertHandoutAccess,
  computeHandoutPermissions,
  type Actor,
} from "./handoutsAccess.helper";
import {
  safeNotifyHandoutEvent,
  getOwnerWorkspaceId,
} from "./handoutsNotify.helper";
// Same path-alias uncertainty handoutsDecision.services.ts flagged for its
// own import of this module — every other import in this file is relative,
// so there's nothing existing to copy the alias from. Adjust to whatever
// your tsconfig actually maps kernel/workflow to.
import {
  assignWorkflow,
  notifyStageApprovers,
} from "@kernel/workflow/workflow.service";
// ✅ NEW — reused (not reimplemented) for getHandoutApprovalWorkflow's
// approval-stage preview below: the same ADMIN-owned-template match rule
// assignWorkflow uses when a handout is actually created.
import { templateMatchResolvers } from "@kernel/workflow/workflow.helper";

// ✅ CHANGED — createHandout now actually attaches a real WorkflowInstance
// (see createHandout below) via the generic kernel engine's assignWorkflow,
// the same one handoutsAccess.helper.ts's isApprover/getActiveHandoutStage
// and handoutsDecision.services.ts's approve/reject already assume exists.
// Before this change, createHandout never called assignWorkflow at all —
// the handout row was created with no WorkflowInstance/StageInstance/
// Approval behind it, so isApprover was false for every request, for
// everyone, forever (the approve/reject/clarify card never had anything to
// show).
//
// ✅ ALSO CHANGED — listHandouts's "approve" view is now scoped to the real,
// dynamic approver (see getHandoutIdsWithPendingApprover below) instead of
// a fixed HANDOUT_APPROVER_USER_ID check. "deliver" is UNCHANGED (delivery
// stays a fixed identity by design — see handoutsAccess.helper.ts's file
// header, confirmed again in chat: delivery is deliberately NOT being
// folded into the workflow engine). getHandoutApprovalWorkflow's Approval
// stage now also resolves from the real WorkflowTemplate (see below);
// its Delivery stage stays env-var based, unchanged by design.
// resubmitHandout is still UNCHANGED / a separate follow-up, not covered by
// this pass.

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

// Result of one create attempt: the handout plus whatever assignWorkflow
// resolved for it, so the caller can notify stage-1 approvers and write an
// ActivityLog entry with a real workflowId/stageId instead of null/null.
type CreateHandoutAttemptResult = {
  handoutId: string;
  workflowId: string;
  stageId?: string;
  approverIds: string[];
};

export const createHandout = async (
  actor: Actor,
  input: CreateHandoutInput,
) => {
  validateCreateInput(input);

  // Resolved once, outside the retry loop below — neither depends on the
  // generated requestNumber, so there's no reason to redo them on a
  // unique-constraint retry.
  const workspaceId = await getOwnerWorkspaceId(actor.id);
  if (!workspaceId) {
    throw new ApiError(
      400,
      "Could not resolve a workspace for this user — cannot raise a handout request",
    );
  }

  const app = await prisma.app.findUnique({
    where: { key: HANDOUT_APP },
    select: { id: true },
  });
  if (!app) {
    throw new ApiError(404, `App "${HANDOUT_APP}" not found`);
  }

  const attempt = async (
    retried: boolean,
  ): Promise<CreateHandoutAttemptResult> => {
    const requestNumber = generateHandoutRequestNumber();
    try {
      // Handout row + workflow attachment in one transaction: if no
      // matching WorkflowTemplate exists for the HANDOUT app (assignWorkflow
      // throws 404/400 — see kernel/workflow/workflow.service.ts), the
      // handout insert rolls back too. That's deliberate — a handout with no
      // approver attached is not a valid "submitted" state, so raising
      // should fail loudly rather than silently leaving the request stuck
      // with nobody able to act on it (the bug this fix replaces).
      return await prisma.$transaction(async (tx) => {
        const handout = await tx.handoutRequest.create({
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

        const { workflowInstance, stageOneApproverIds, stageOneId } =
          await assignWorkflow(tx, {
            subjectType: "HANDOUT_REQUEST",
            subjectId: handout.id,
            workspaceId,
            appId: app.id,
            userId: actor.id,
          });

        return {
          handoutId: handout.id,
          workflowId: workflowInstance.id,
          stageId: stageOneId,
          approverIds: stageOneApproverIds,
        };
      });
    } catch (error: any) {
      // Collision on the requestNumber unique constraint (two requests
      // generated in the same second) — same acceptance EPC makes:
      // retry exactly once with a fresh timestamp, never loop forever.
      // Rolling back inside $transaction above means a collision retry
      // never leaves a half-created WorkflowInstance behind either.
      if (!retried && error?.code === PRISMA_UNIQUE_CONSTRAINT_CODE) {
        return attempt(true);
      }
      throw error;
    }
  };

  const { handoutId, workflowId, stageId, approverIds } = await attempt(false);

  // Real workflowId/stageId now, instead of the null/null every other
  // ActivityLog write in this file still uses for its Handout-specific
  // (non-engine) actions.
  await prisma.activityLog.create({
    data: {
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      actorId: actor.id,
      action: "SUBMITTED",
      workflowId,
      stageId: stageId ?? null,
    },
  });

  // Notifies whoever stage 1's real approver(s) are — replaces the old
  // safeNotifyHandoutEvent("SUBMITTED") call, which (per
  // handoutsNotify.helper.ts's own header comment) was already superseded:
  // "SUBMITTED" has no EVENT_COPY/resolveRecipients case left there, so it
  // was a silent no-op. This is the real notification path now.
  if (stageId) {
    await notifyStageApprovers({
      workflowId,
      subjectType: "HANDOUT_REQUEST",
      subjectId: handoutId,
      appId: app.id,
      stageId,
      approverIds,
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

// ✅ NEW — real dynamic scoping for listHandouts's "approve" view, replacing
// the old `actor.id === HANDOUT_APPROVER_USER_ID` fixed-identity check.
// Returns every HandoutRequest id whose active WorkflowInstance has a
// currently IN_PROGRESS stage on which `approverId` holds a PENDING
// Approval — i.e. "every request actually waiting on this person right
// now", the same resolution handoutsAccess.helper.ts's isApprover uses for
// one handout, just across all of them at once. An empty result means
// nothing is currently pending on this person, not that they lack
// permission — HANDOUT_MODULE write access (route-level authorize()) is
// what gates whether they can call this endpoint at all.
const getHandoutIdsWithPendingApprover = async (
  approverId: string,
): Promise<string[]> => {
  const stages = await prisma.stageInstance.findMany({
    where: {
      isCurrentIteration: true,
      status: "IN_PROGRESS",
      approvals: { some: { approverId, status: "PENDING" } },
      workflow: { subjectType: "HANDOUT_REQUEST", isActive: true },
    },
    select: { workflow: { select: { subjectId: true } } },
  });
  return stages.map((stage) => stage.workflow.subjectId);
};

export const listHandouts = async (actor: Actor, params: ListHandoutsInput) => {
  const where: any = {};

  if (params.view === "mine") {
    where.requestedById = actor.id;
  } else if (params.view === "approve") {
    // ✅ CHANGED — see getHandoutIdsWithPendingApprover above. No 403 for
    // "not an approver on anything right now" — same posture as "mine" for
    // someone with no requests: an empty queue, not an error.
    const pendingHandoutIds = await getHandoutIdsWithPendingApprover(actor.id);
    if (pendingHandoutIds.length === 0) {
      return { items: [], total: 0 };
    }
    where.id = { in: pendingHandoutIds };
    where.status = HANDOUT_STATUS.PENDING_APPROVAL;
  } else if (params.view === "deliver") {
    // UNCHANGED — delivery stays a fixed identity by design (see
    // handoutsAccess.helper.ts's file header, confirmed again in chat).
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
// ⚠️ UNCHANGED (separate follow-up, not covered by this pass) — does not
// reactivate the WorkflowInstance's stage (no call to
// activateFirstStageForResubmit). See clarifyHandout's own comment in
// handoutsDecision.services.ts for why clarify never touched the stage in
// the first place.

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

// ── Approval workflow (display only) ────────────────────────────────────────
//
// GET /handouts/approval-workflow — no handoutId (confirmed: the only route
// for this, no :id anywhere); used both by NewHandoutPage's pre-submit
// review step and by HandoutDetailPage's Info tab, both just overlaying
// their own already-known HandoutRequest.status on top of this "who" data
// (see handoutApprovalWorkflow.mapper.ts on the frontend) — this function
// never needs to know which handout, if any, it's being shown for.
//
// ✅ CHANGED — the Approval stage now resolves the real, admin-configured
// WorkflowTemplate (the same ADMIN-owned-template match rule assignWorkflow
// uses, reused here via templateMatchResolvers rather than reimplemented)
// instead of the fixed HANDOUT_APPROVER_USER_ID env var — this was the
// actual staleness: approval itself moved onto the generic workflow engine
// a few fixes back, but this display endpoint never caught up.
//
// Delivery stays exactly as it was — the fixed HANDOUT_DELIVERY_USER_ID env
// var — by explicit decision (not promoted into the workflow engine; see
// handoutsAccess.helper.ts's isDeliveryTeam and this file's own header).
// Wrapped as a one-element `approvers` array purely so both stages share
// one response shape on the wire.

type FixedRoleUser = {
  first_name: string;
  last_name: string;
  email: string | null;
  designation: { name: string } | null;
};

type HandoutApprovalWorkflowApprover = {
  name: string;
  email: string;
  designation: string | null;
};

const describeFixedRoleUser = (
  user: FixedRoleUser | null | undefined,
  fallbackName: string,
): HandoutApprovalWorkflowApprover => {
  if (!user) {
    return { name: fallbackName, email: "--", designation: null };
  }

  return {
    name: `${user.first_name} ${user.last_name}`.trim() || fallbackName,
    email: user.email?.trim() || "--",
    designation: user.designation?.name ?? null,
  };
};

export const getHandoutApprovalWorkflow = async (actor: Actor) => {
  const workspaceId = await getOwnerWorkspaceId(actor.id);
  if (!workspaceId) {
    throw new ApiError(
      400,
      "Could not resolve a workspace for this user — cannot resolve the approval workflow",
    );
  }

  const app = await prisma.app.findUnique({
    where: { key: HANDOUT_APP },
    select: { id: true },
  });
  if (!app) {
    throw new ApiError(404, `App "${HANDOUT_APP}" not found`);
  }

  // Read-only preview — same lookup+match shape assignWorkflow uses
  // (kernel/workflow/workflow.service.ts), just never writing a
  // WorkflowInstance. Mirrors how the kernel's own previewWorkflowController
  // previews other subject types' templates.
  //
  // This include is intentionally richer than templateMatchResolvers'
  // declared `CandidateTemplate` type (kernel/workflow/workflow.helper.ts),
  // which only asks for `approvers: true` — no nested `user` — because none
  // of the *other* subject types' resolvers need approver identities, only
  // this display endpoint does. See the cast below for why that's safe.
  const templates = await prisma.workflowTemplate.findMany({
    where: { workspaceId, appId: app.id, isActive: true },
    include: {
      stages: {
        include: {
          approvers: {
            include: {
              user: {
                select: {
                  first_name: true,
                  last_name: true,
                  email: true,
                  designation: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { stageOrder: "asc" },
      },
    },
  });
  type TemplateWithApproverUsers = (typeof templates)[number];

  // templateMatchResolvers' shared function type takes (templates, criteria)
  // and returns an element of the *declared* `CandidateTemplate[]` shape —
  // assignWorkflow/previewWorkflowController always pass both arguments,
  // even when a specific resolver (like HANDOUT_REQUEST's) ignores
  // criteria entirely, so the explicit `undefined` second argument is
  // required to satisfy that shared signature.
  //
  // The declared return type (CandidateTemplate, approvers without `user`)
  // is narrower than what we actually queried above — HANDOUT_REQUEST's
  // resolver body is just `templates.find(...)`, so the value it hands
  // back is literally one of this file's own richer `templates` entries.
  // The cast below restores that richer, actually-correct type rather than
  // reimplementing the match predicate here a second time (which would
  // just be the same DRY violation in the other direction).
  const matchedTemplate = templateMatchResolvers.HANDOUT_REQUEST(
    templates,
    undefined,
  ) as TemplateWithApproverUsers | undefined;
  const approvalStage = matchedTemplate?.stages.find(
    (stage) => stage.stageOrder === 1,
  );

  const approvalApprovers: HandoutApprovalWorkflowApprover[] =
    approvalStage?.approvers.map((approver) =>
      describeFixedRoleUser(approver.user, "Approver"),
    ) ?? [];

  const deliveryUser = HANDOUT_DELIVERY_USER_ID
    ? await prisma.user.findUnique({
        where: { id: HANDOUT_DELIVERY_USER_ID },
        select: {
          first_name: true,
          last_name: true,
          email: true,
          designation: { select: { name: true } },
        },
      })
    : null;

  return {
    stages: [
      {
        stageOrder: 1,
        stageName: approvalStage?.name ?? "Approval",
        strategy: approvalStage?.strategy ?? null,
        minApprovals: approvalStage?.minApprovals ?? null,
        // Falls back to a single placeholder entry only if the template
        // somehow has no approvers configured yet — keeps the display
        // non-empty rather than showing a blank stage.
        approvers: approvalApprovers.length
          ? approvalApprovers
          : [describeFixedRoleUser(null, "Marketing Head")],
      },
      {
        stageOrder: 2,
        stageName: "Hand delivery",
        // Not template-derived — a fixed single identity by design.
        strategy: null,
        minApprovals: 1,
        approvers: [describeFixedRoleUser(deliveryUser, "Delivery Team")],
      },
    ],
  };
};

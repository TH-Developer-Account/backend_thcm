// handouts/handoutsNotify.helper.ts
//
// Two-channel notification pairing (notify() + addMailJob()), mirroring
// crfOrder.services.ts's notifyCrfEvent/safeNotifyCrfEvent. Always called
// AFTER the transaction that changed the handout has committed, and always
// through the "safe" wrapper so a notification failure can never fail an
// operation that already succeeded.
//
// ✅ CHANGED — approval is now a generic-kernel event (approveStage/
// rejectStage in workflow.service.ts), and that engine already sends its
// own notification to the requester on both approve and reject. Firing
// this module's notification for the SAME leg would double-notify the
// requester, so:
//   - SUBMITTED is removed entirely — notifyStageApprovers (the generic
//     engine's own "a stage just activated" notify, called from
//     handouts.services.ts's createHandout) now covers what this event
//     used to do for the approver.
//   - REJECTED is removed entirely — rejectStage's own notify covers it.
//   - APPROVED keeps firing, but ONLY notifies the delivery person now
//     (requestedById dropped from its recipient list below) — "it's now
//     your queue" has no generic-engine equivalent at all, since the
//     kernel has no concept of a delivery stage. The requester's "you've
//     been approved" notice comes from approveStage's own notify.
// RESUBMITTED and CANCELLED still need to reach the approver, but that's
// no longer a fixed env-var identity — resolveRecipients now resolves it
// from the handout's active workflow stage, the same way
// handoutsAccess.helper.ts's isApprover does.

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { notify } from "@kernel/notifications/notification.services";
import { addMailJob } from "@kernel/mail/mail.service";
import {
  HANDOUT_APP,
  HANDOUT_DELIVERY_USER_ID,
  HANDOUTS_BASE_PATH,
} from "./handoutStatus.constants";
import { getActiveHandoutStage } from "./handoutsAccess.helper";
import type { Actor } from "./handoutsAccess.helper";

// Exported — reused by handouts.services.ts's createHandout, which also
// needs the requester's workspaceId to call the generic engine's
// assignWorkflow. One resolver, not two copies of the same WorkspaceUser
// lookup.
export const getOwnerWorkspaceId = async (
  userId: string,
): Promise<string | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceUsers: { select: { workspaceId: true }, take: 1 } },
  });
  return user?.workspaceUsers[0]?.workspaceId ?? null;
};

export type HandoutNotifyEvent =
  | "RESUBMITTED"
  | "APPROVED"
  | "CLARIFICATION_REQUESTED"
  | "CANCELLED"
  | "CANNOT_FULFIL"
  | "DELIVERED"
  | "TRACKING_UPDATED";

const EVENT_COPY: Record<
  HandoutNotifyEvent,
  { title: string; body: (comment?: string) => string }
> = {
  RESUBMITTED: {
    title: "Handout request resubmitted",
    body: () => "A handout request was updated and resubmitted for approval.",
  },
  APPROVED: {
    // Delivery-only now (see file header) — copy adjusted accordingly.
    title: "Handout request approved — ready for delivery",
    body: () =>
      "A handout request has been approved and the order has been placed. It's ready in your delivery queue.",
  },
  CLARIFICATION_REQUESTED: {
    title: "Clarification requested on your handout request",
    body: (comment) =>
      comment
        ? `The approver needs more information: ${comment}`
        : "The approver has requested clarification on your handout request.",
  },
  CANCELLED: {
    title: "Handout request cancelled",
    body: (comment) =>
      comment
        ? `The request was cancelled: ${comment}`
        : "The handout request was cancelled.",
  },
  CANNOT_FULFIL: {
    title: "Handout request cannot be fulfilled",
    body: (comment) =>
      comment
        ? `This request cannot be fulfilled: ${comment}`
        : "This handout request could not be fulfilled — some items are out of stock.",
  },
  DELIVERED: {
    title: "Handout delivered",
    body: () => "The handout request has been marked as delivered.",
  },
  TRACKING_UPDATED: {
    title: "Tracking available for your handout request",
    body: () => "Tracking information is now available for your handout order.",
  },
};

// Who gets notified, per event — strictly by stage: only whoever the ball
// is actually with next (plus the requester, when there's something for
// them to be told that the generic engine doesn't already cover). Never
// both the approver and delivery person on the same event.
//
// ✅ CHANGED — now async and takes handoutId, because RESUBMITTED/CANCELLED
// resolve their recipient dynamically (whoever is a PENDING approver on
// the active, IN_PROGRESS stage) instead of a fixed HANDOUT_APPROVER_USER_ID.
const resolveRecipients = async (
  handoutId: string,
  requestedById: string,
  event: HandoutNotifyEvent,
): Promise<string[]> => {
  switch (event) {
    case "RESUBMITTED":
    case "CANCELLED": {
      // Resubmitted/cancelled requests go back to whoever is currently the
      // pending approver on this handout's active stage — same resolution
      // handoutsAccess.helper.ts's isApprover uses, so "who gets notified"
      // and "who is allowed to act" never drift apart.
      const { stage } = await getActiveHandoutStage(handoutId);
      return (
        stage?.approvals
          .filter((approval) => approval.status === "PENDING")
          .map((approval) => approval.approverId) ?? []
      );
    }
    case "APPROVED":
      // Delivery person only — the requester's own "approved" notice now
      // comes from the generic engine's approveStage, not from here.
      return [HANDOUT_DELIVERY_USER_ID];
    case "CLARIFICATION_REQUESTED":
    case "CANNOT_FULFIL":
      return [requestedById];
    case "DELIVERED":
      return [requestedById];
    case "TRACKING_UPDATED":
      return [requestedById];
    default:
      return [];
  }
};

export const notifyHandoutEvent = async (params: {
  handoutId: string;
  event: HandoutNotifyEvent;
  // Optional: every actor-driven decision (clarify/cancel/...) passes one,
  // but it is never actually read in this function (recipients are
  // resolved purely from the event + the request's own requestedById/
  // active stage below) — it's only kept on the type for parity with the
  // ActivityLog writes at each call site. TRACKING_UPDATED is
  // system-triggered (the Shopify webhook, no MAP user behind it — same
  // posture as crfOrder.services.ts's recordShopifyTracking), so it's the
  // one caller with no actor to pass.
  actor?: Actor;
  comment?: string;
  // TRACKING_UPDATED-only — threaded straight into the email template's
  // {{trackingId}}/{{trackingUrl}}. Every other event leaves these unset.
  trackingId?: string;
  trackingUrl?: string;
}): Promise<void> => {
  const handout = await prisma.handoutRequest.findUnique({
    where: { id: params.handoutId },
    select: { requestNumber: true, requestedById: true },
  });
  if (!handout) return;

  const workspaceId = await getOwnerWorkspaceId(handout.requestedById);
  if (!workspaceId) {
    logger.error(
      `[handoutsNotify.helper] Requester ${handout.requestedById} has no workspace membership — skipping notification for handout ${params.handoutId}`,
    );
    return;
  }

  const recipientIds = [
    ...new Set(
      (
        await resolveRecipients(
          params.handoutId,
          handout.requestedById,
          params.event,
        )
      ).filter(Boolean),
    ),
  ];
  if (recipientIds.length === 0) return;

  const recipients = await prisma.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, email: true },
  });

  const copy = EVENT_COPY[params.event];
  const title = `${copy.title} — ${handout.requestNumber}`;
  const body = copy.body(params.comment);
  const link = `${HANDOUTS_BASE_PATH}/${params.handoutId}`;

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
          appKey: HANDOUT_APP,
          subjectType: "HANDOUT_REQUEST",
          subjectId: params.handoutId,
        },
      }),
    ),
    ...recipients
      .filter((recipient) => recipient.email)
      .map((recipient) =>
        addMailJob({
          to: recipient.email as string,
          subject: title,
          templateName: `handout-${params.event.toLowerCase().replace(/_/g, "-")}`,
          templateData: {
            requestNumber: handout.requestNumber,
            comment: params.comment ?? null,
            trackingId: params.trackingId ?? null,
            trackingUrl: params.trackingUrl ?? null,
            dashboardUrl: `${process.env.FRONTEND_URL ?? ""}${link}`,
          },
        }),
      ),
  ]);
};

export const safeNotifyHandoutEvent = async (
  params: Parameters<typeof notifyHandoutEvent>[0],
): Promise<void> => {
  try {
    await notifyHandoutEvent(params);
  } catch (error: any) {
    logger.error(
      `[handoutsNotify.helper] Notification failed for handout ${params.handoutId}: ${error.message}`,
    );
  }
};

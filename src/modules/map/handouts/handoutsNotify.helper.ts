// handouts/handoutsNotify.helper.ts
//
// Two-channel notification pairing (notify() + addMailJob()), mirroring
// crfOrder.services.ts's notifyCrfEvent/safeNotifyCrfEvent. Always called
// AFTER the transaction that changed the handout has committed, and always
// through the "safe" wrapper so a notification failure can never fail an
// operation that already succeeded.
//
// Recipients are resolved by stage, not broadcast to both roles on every
// event: the approver hears about a new/resubmitted/cancelled request (it's
// their queue), the delivery person hears about an approval (it's now their
// queue) — each told only when the ball is actually in their court. This
// also replaces an earlier, unverified attempt to resolve "everyone with
// HANDOUT module write access" by reconstructing the RBAC schema's
// Profile/Module/AppAdministrator tables by hand; approver and delivery
// person are now fixed, environment-configured ids (handoutStatus.constants.ts),
// so there is no dynamic set to query here at all.

import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { notify } from "@kernel/notifications/notification.services";
import { addMailJob } from "@kernel/mail/mail.service";
import {
  HANDOUT_APP,
  HANDOUT_APPROVER_USER_ID,
  HANDOUT_DELIVERY_USER_ID,
  HANDOUTS_BASE_PATH,
} from "./handoutStatus.constants";
import type { Actor } from "./handoutsAccess.helper";

const getOwnerWorkspaceId = async (userId: string): Promise<string | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceUsers: { select: { workspaceId: true }, take: 1 } },
  });
  return user?.workspaceUsers[0]?.workspaceId ?? null;
};

export type HandoutNotifyEvent =
  | "SUBMITTED"
  | "RESUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "CLARIFICATION_REQUESTED"
  | "CANCELLED"
  | "CANNOT_FULFIL"
  | "DELIVERED"
  | "TRACKING_UPDATED";

const EVENT_COPY: Record<
  HandoutNotifyEvent,
  { title: string; body: (comment?: string) => string }
> = {
  SUBMITTED: {
    title: "New handout request submitted",
    body: () => "A new handout request is waiting for your approval.",
  },
  RESUBMITTED: {
    title: "Handout request resubmitted",
    body: () => "A handout request was updated and resubmitted for approval.",
  },
  APPROVED: {
    title: "Handout request approved",
    body: () =>
      "Your handout request has been approved and the order has been placed.",
  },
  REJECTED: {
    title: "Handout request rejected",
    body: (comment) =>
      comment
        ? `Your handout request was rejected: ${comment}`
        : "Your handout request was rejected.",
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
// them to be told). Never both the approver and delivery person on the
// same event.
const resolveRecipients = (
  requestedById: string,
  event: HandoutNotifyEvent,
): string[] => {
  switch (event) {
    case "SUBMITTED":
    case "RESUBMITTED":
      // New/updated request — it's waiting in the approver's queue.
      return [HANDOUT_APPROVER_USER_ID];
    case "APPROVED":
      // Owner (order placed) + delivery person (it's now their queue).
      // The approver's part is done — not notified again here.
      return [requestedById, HANDOUT_DELIVERY_USER_ID];
    case "REJECTED":
    case "CLARIFICATION_REQUESTED":
    case "CANNOT_FULFIL":
      return [requestedById];
    case "CANCELLED":
      // Requester cancelled it themselves — tell the approver so a
      // pending item disappears from their queue with an explanation.
      return [HANDOUT_APPROVER_USER_ID];
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
  // Optional: every actor-driven decision (approve/reject/...) passes one,
  // but it is never actually read in this function (recipients are
  // resolved purely from the event + the request's own requestedById
  // below) — it's only kept on the type for parity with the ActivityLog
  // writes at each call site. TRACKING_UPDATED is system-triggered (the
  // Shopify webhook, no MAP user behind it — same posture as
  // crfOrder.services.ts's recordShopifyTracking), so it's the one caller
  // with no actor to pass.
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
      resolveRecipients(handout.requestedById, params.event).filter(Boolean),
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

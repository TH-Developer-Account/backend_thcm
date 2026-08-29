import webpush from "web-push";
import { prisma } from "@shared/config/prisma";
import { redisConnectionPublisher } from "@shared/config/redis";
import { notificationDeliveryQueue } from "./notification.queue";
import { Prisma } from "../../prisma/generated/prisma/browser";

// ─────────────────────────────────────────────────────────────────────────────
// notification.service.ts
//
// Single entry point every app (MAP, DIA, Dealer Claims, future apps) calls
// to raise a notification: notify(). No app-specific branching lives here —
// callers pass a `type` + `metadata`; this service only knows how to
// persist, enqueue, and (later, via the worker) deliver — never how to
// interpret a specific app's domain.
//
// File layout:
//   1. notify()                         — write side, called from controllers
//   2. listNotifications / getUnreadCount / markAsRead / markAllAsRead
//                                        — read side, called from controllers
//   3. subscribeToPush / unsubscribeFromPush
//                                        — push subscription management
//   4. deliverNotification()            — delivery side, called from the
//                                          BullMQ worker (workers/index.ts),
//                                          NOT from controllers
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Write side ────────────────────────────────────────────────────────────

export type NotificationType =
  | "APPROVAL_PENDING"
  | "APPROVAL_DECISION"
  | "REPORT_STATUS"
  | "GENERIC";

type NotifyParams = {
  workspaceId: string;
  recipientId: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  metadata?: Record<string, unknown>;
};

// notify() is intentionally synchronous-fast: one INSERT + one queue add,
// no network calls to push/SSE providers. Callers (controllers) can await
// this without meaningfully delaying their HTTP response.
export async function notify(params: NotifyParams): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      workspaceId: params.workspaceId,
      recipientId: params.recipientId,
      type: params.type,
      title: params.title,
      body: params.body,
      link: params.link,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  await notificationDeliveryQueue.add("deliver", {
    notificationId: notification.id,
    recipientId: params.recipientId,
  });
}

// ── 2. Read side ─────────────────────────────────────────────────────────────

type ListNotificationsParams = {
  recipientId: string;
  cursor?: string; // notification id to paginate after
  limit?: number;
};

export async function listNotifications(params: ListNotificationsParams) {
  const limit = params.limit ?? 20;

  return prisma.notification.findMany({
    where: { recipientId: params.recipientId },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(params.cursor && {
      cursor: { id: params.cursor },
      skip: 1, // skip the cursor row itself
    }),
  });
}

export async function getUnreadCount(recipientId: string): Promise<number> {
  return prisma.notification.count({
    where: { recipientId, isRead: false },
  });
}

export async function markAsRead(
  notificationId: string,
  recipientId: string,
): Promise<void> {
  // recipientId in the WHERE clause, not just the id — prevents one user
  // from marking another user's notification as read via a guessed id.
  await prisma.notification.updateMany({
    where: { id: notificationId, recipientId },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function markAllAsRead(recipientId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { recipientId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
}

// ── 3. Push subscription management ─────────────────────────────────────────
// Folded into this file per your preference, kept as clearly separate
// functions so the responsibility boundary stays visible.

type SubscribeToPushParams = {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

export async function subscribeToPush(params: SubscribeToPushParams) {
  // Upsert on endpoint: a browser re-registering its service worker sends
  // the same endpoint again — update in place rather than duplicating.
  return prisma.pushSubscription.upsert({
    where: { endpoint: params.endpoint },
    create: params,
    update: {
      userId: params.userId,
      p256dh: params.p256dh,
      auth: params.auth,
      userAgent: params.userAgent,
    },
  });
}

export async function unsubscribeFromPush(
  endpoint: string,
  userId: string,
): Promise<void> {
  await prisma.pushSubscription.deleteMany({
    where: { endpoint, userId },
  });
}

// ── 4. Delivery side (worker-only) ──────────────────────────────────────────

const SSE_CHANNEL = "sse:notify";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT as string, // e.g. "mailto:admin@tatahitachi.example"
  process.env.VAPID_PUBLIC_KEY as string,
  process.env.VAPID_PRIVATE_KEY as string,
);

async function deliverViaWebPush(
  recipientId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: recipientId },
  });

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
      } catch (error: any) {
        // 410 Gone / 404 — subscription is dead (unsubscribed, site data
        // cleared). Remove it so we stop retrying forever.
        if (error?.statusCode === 410 || error?.statusCode === 404) {
          await prisma.pushSubscription.delete({
            where: { id: subscription.id },
          });
        }
        // Other errors are left to BullMQ's job-level retry/backoff.
      }
    }),
  );
}

async function deliverViaSse(
  recipientId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Publishes only — the SSE registry and the subscriber that reads this
  // channel both live in the API process (server.ts), since that's the
  // process holding the actual open HTTP connections. This worker process
  // has none of its own. See realtime/sse.bootstrap.ts.
  await redisConnectionPublisher.publish(
    SSE_CHANNEL,
    JSON.stringify({ recipientId, payload }),
  );
}

// Called by the BullMQ worker in workers/index.ts — never by controllers.
export async function deliverNotification(
  notificationId: string,
): Promise<void> {
  const notification = await prisma.notification.findUniqueOrThrow({
    where: { id: notificationId },
  });

  const payload = {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    createdAt: notification.createdAt,
  };

  console.log(
    "called for delivery of notification",
    notificationId,
    "to recipient",
    notification.recipientId,
  );

  await Promise.allSettled([
    deliverViaWebPush(notification.recipientId, payload),
    deliverViaSse(notification.recipientId, payload),
  ]);
}

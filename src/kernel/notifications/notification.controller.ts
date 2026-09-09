import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";

import * as notificationService from "./notification.services";
import { registerConnection, removeConnection } from "./sse.registry";
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

// ─────────────────────────────────────────────────────────────────────────────
// notification.controller.ts
//
// Every handler resolves recipientId from req.user.id — a user can only ever
// read/mutate their OWN notifications. There is no "list notifications for
// another user" capability anywhere in this controller; recipientId is never
// taken from req.params or req.body.
// ─────────────────────────────────────────────────────────────────────────────

// GET /notifications?cursor=&limit=
export const listNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { cursor, limit } = req.query;

    const notifications = await notificationService.listNotifications({
      recipientId: userId,
      cursor: cursor as string | undefined,
      limit: limit ? Number(limit) : undefined,
    });

    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    next(error);
  }
};

// GET /notifications/unread-count
export const getUnreadCount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const count = await notificationService.getUnreadCount(userId);

    res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    next(error);
  }
};

// PATCH /notifications/:id/read
export const markAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { id } = req.params;
    await notificationService.markAsRead(id as string, userId);

    res
      .status(200)
      .json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    next(error);
  }
};

// PATCH /notifications/read-all
export const markAllAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    await notificationService.markAllAsRead(userId);

    res
      .status(200)
      .json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    next(error);
  }
};

// GET /notifications/stream (SSE)
//
// Long-lived connection — left open until the client disconnects.
// Auth must already have resolved req.user by the time this handler runs
// (same auth middleware as every other route — no special-casing for SSE).
export const streamNotifications = (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n"); // flush headers immediately so the client's EventSource opens

  registerConnection(userId, res);

  // SSE comment lines (": ping") are ignored by the browser's EventSource
  // but keep the TCP connection alive through proxies and load balancers
  // that would otherwise close idle connections (nginx default: 60s).
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeConnection(userId, res);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    removeConnection(userId, res);
  });
};

// POST /notifications/push-subscriptions
export const subscribeToPush = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new ApiError(
        400,
        "endpoint and keys.p256dh/keys.auth are required",
      );
    }

    await notificationService.subscribeToPush({
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.headers["user-agent"],
    });

    res.status(201).json({ success: true, message: "Push subscription saved" });
  } catch (error) {
    next(error);
  }
};

// DELETE /notifications/push-subscriptions
export const unsubscribeFromPush = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { endpoint } = req.body;
    if (!endpoint) throw new ApiError(400, "endpoint is required");

    await notificationService.unsubscribeFromPush(endpoint, userId);

    res
      .status(200)
      .json({ success: true, message: "Push subscription removed" });
  } catch (error) {
    next(error);
  }
};

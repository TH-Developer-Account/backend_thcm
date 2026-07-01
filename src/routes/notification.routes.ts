import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  listNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
  streamNotifications,
  subscribeToPush,
  unsubscribeFromPush,
} from "../controllers/notification.controller";
import { requireAuth } from "../middleware/auth.middleware"; // ⚠️ confirm actual export name/path

// ─────────────────────────────────────────────────────────────────────────────
// notification.routes.ts
//
// Single route file for the whole notification domain (list, read receipts,
// SSE stream, push subscriptions) — per your route-consolidation preference,
// registered once in app.ts as app.use("/api/v1/notifications", notificationRoutes).
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(listNotifications));
router.get("/unread-count", asyncHandler(getUnreadCount));
router.patch("/read-all", asyncHandler(markAllAsRead));
router.patch("/:id/read", asyncHandler(markAsRead));
router.get("/stream", streamNotifications);
router.post("/push-subscriptions", asyncHandler(subscribeToPush));
router.delete("/push-subscriptions", asyncHandler(unsubscribeFromPush));

export default router;

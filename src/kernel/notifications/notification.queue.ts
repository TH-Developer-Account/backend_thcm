import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// notification_queue.ts
//
// Separate queue (not folded into an existing one) — same reasoning as
// epc-export: delivery failures (push/SSE) have a different retry profile
// than export jobs, and we want to monitor/drain this queue independently.
//
// Job payload is intentionally minimal (just the id). The worker re-reads
// the Notification row rather than trusting stale job data — avoids a class
// of bugs where the row changes (e.g. gets marked read) between enqueue and
// processing.
// ─────────────────────────────────────────────────────────────────────────────

export type NotificationDeliveryJobData = {
  notificationId: string;
  recipientId: string;
};

export const notificationDeliveryQueue = new Queue<NotificationDeliveryJobData>(
  "notification-delivery",
  {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { age: 60 * 60 * 6 },
      removeOnFail: { age: 60 * 60 * 24 * 3 },
    },
  },
);

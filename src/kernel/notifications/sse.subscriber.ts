import { redisConnectionSubscriber } from "@shared/config/redis";
import { writeToUser } from "./sse.registry";

// ─────────────────────────────────────────────────────────────────────────────
// sse.bootstrap.ts
//
// Call startSseSubscriber() ONCE, from server.ts only — never from the
// worker process. This is the bridge between "a notification was delivered
// somewhere" (published by notification.service.ts's deliverNotification,
// running in the worker process) and "write it to this specific open
// connection if I happen to be holding it" (this process, the API process,
// which is the only one with real Express res objects in sse.registry.ts).
// ─────────────────────────────────────────────────────────────────────────────

const SSE_CHANNEL = "sse:notify";

export function startSseSubscriber(): void {
  redisConnectionSubscriber.subscribe(SSE_CHANNEL, (err) => {
    if (err) {
      console.error("Failed to subscribe to SSE channel:", err.message);
      return;
    }
    console.info(`Subscribed to Redis channel: ${SSE_CHANNEL}`);
  });

  redisConnectionSubscriber.on("message", (channel, message) => {
    if (channel !== SSE_CHANNEL) return;

    try {
      const { recipientId, payload } = JSON.parse(message);
      writeToUser(recipientId, payload);
    } catch (error) {
      console.error("Failed to parse SSE pub/sub message:", error);
    }
  });
}

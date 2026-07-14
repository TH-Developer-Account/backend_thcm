import { Response } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// sse.registry.ts
//
// Deliberate exception to "prefer pure functions": this module holds mutable
// process-level state (open HTTP connections) because that's literally what
// it's tracking — there is no pure way to represent "a socket is open."
//
// Scope is kept narrow on purpose: this file ONLY tracks connections and
// writes raw payloads to them. It has no knowledge of notifications, Redis,
// or BullMQ — that logic lives in the worker, which calls writeToUser().
// Multiple tabs/devices per user are supported (array of Response per userId).
// ─────────────────────────────────────────────────────────────────────────────

const connectionsByUserId = new Map<string, Response[]>();

export function registerConnection(userId: string, res: Response): void {
  const existing = connectionsByUserId.get(userId) ?? [];
  connectionsByUserId.set(userId, [...existing, res]);
}

export function removeConnection(userId: string, res: Response): void {
  const remaining = (connectionsByUserId.get(userId) ?? []).filter(
    (connection) => connection !== res,
  );

  if (remaining.length > 0) {
    connectionsByUserId.set(userId, remaining);
  } else {
    connectionsByUserId.delete(userId);
  }
}

// Called by the Redis subscriber when a notification is published for a user.
// Only writes if THIS process happens to hold that user's connection —
// safe to call on every process even when the user isn't connected here.
export function writeToUser(userId: string, payload: unknown): void {
  const connections = connectionsByUserId.get(userId);
  if (!connections) return;

  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of connections) {
    res.write(serialized);
  }
}

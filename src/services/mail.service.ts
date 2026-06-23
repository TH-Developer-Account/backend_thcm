import { mailQueue, MailJobPayload } from "./mail.queue";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────────────
// addMailJob — public API for the mail system.
//
// WHY this wrapper exists (instead of importing mailQueue directly):
//   - Controllers depend on this abstraction, not on BullMQ internals.
//   - If we ever swap BullMQ for another queue (or a direct SMTP call in tests),
//     only this file changes — zero controller changes needed. (DIP / SOLID)
//   - Error in job enqueue is caught and logged here so it can never
//     propagate and break the calling request. (silent fail contract)
//
// Usage:
//   import { addMailJob } from "../services/mail.service";
//
//   await addMailJob({
//     to: "approver@company.com",
//     cc: ["manager@company.com"],
//     subject: "Your approval is required",
//     templateName: "approval-approved",
//     templateData: { approverName: "John", epcName: "Q3 Event" },
//   });
// ─────────────────────────────────────────────────────────────────────────────

export async function addMailJob(payload: MailJobPayload): Promise<void> {
  try {
    await mailQueue.add("send-mail", payload);

    logger.info(
      `[MailService] Job enqueued — template: "${payload.templateName}", ` +
        `to: ${[payload.to].flat().join(", ")}`,
    );
  } catch (error: any) {
    // Enqueue failure (e.g. Redis is down) — log and continue.
    // Never let a mail failure break the parent operation.
    logger.error(
      `[MailService] Failed to enqueue mail job — template: "${payload.templateName}". ` +
        `Error: ${error.message}`,
    );
  }
}

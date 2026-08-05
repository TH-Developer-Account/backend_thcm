import { Queue, Worker, Job } from "bullmq";
import transporter from "@kernel/mail/mail.config";
import { compileTemplate } from "./mail.template";
import logger from "@shared/utils/logger";
import { redisConnectionQueue } from "@shared/config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// MailJobPayload — everything a job needs to send one email.
//
// templateName maps directly to a file in src/templates/emails/
// templateData is the context injected into that template.
// ─────────────────────────────────────────────────────────────────────────────

export interface MailJobPayload {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  templateName: string;
  templateData: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis connection config
//
// WHY separate `connection` object: BullMQ requires the same connection object
// passed to both Queue and Worker — reusing it avoids two separate Redis
// clients for the same purpose.
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_NAME = "mail-queue";

// ── Queue (producer side) ─────────────────────────────────────────────────────
// Controllers only import addMailJob — they never touch the queue directly.

export const mailQueue = new Queue<MailJobPayload>(QUEUE_NAME, {
  connection: redisConnectionQueue,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      // Exponential: attempt 1 fails → wait 2s, attempt 2 fails → wait 4s
      type: "exponential",
      delay: 2000,
    },
    // Auto-remove completed/failed jobs — keeps Redis lean.
    // Retain last 50 completed and last 100 failed for debugging.
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

// ── Worker (consumer side) ────────────────────────────────────────────────────
// Runs in the same process. One concurrency slot is enough for a shared
// O365 SMTP account — avoids hitting Microsoft's rate limits.

const mailWorker = new Worker<MailJobPayload>(
  QUEUE_NAME,
  async (job: Job<MailJobPayload>) => {
    const { to, cc, subject, templateName, templateData } = job.data;

    const html = compileTemplate(templateName, templateData);

    await transporter.sendMail({
      from: process.env.GMAIL_MAIL_ID,
      to,
      ...(cc ? { cc } : {}),
      subject,
      html,
    });

    logger.info(
      `[MailWorker] Sent "${subject}" → ${[to].flat().join(", ")} ` +
        `(job ${job.id}, attempt ${job.attemptsMade + 1})`,
    );
  },
  {
    connection: redisConnectionQueue,
    concurrency: 1,
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Worker event handlers
//
// WHY log on "failed" (not just "error"): BullMQ fires "failed" only after
// all retry attempts are exhausted. "error" fires on every attempt failure.
// We want silent retry during attempts, and a single final log on exhaustion.
// ─────────────────────────────────────────────────────────────────────────────

mailWorker.on("failed", (job, error) => {
  logger.error(
    `[MailWorker] Job ${job?.id} exhausted all retries. ` +
      `Subject: "${job?.data?.subject}". Error: ${error.message}`,
  );
});

mailWorker.on("error", (error) => {
  // Worker-level errors (e.g. Redis disconnect) — not job-level failures
  logger.error(`[MailWorker] Worker error: ${error.message}`);
});

export default mailWorker;

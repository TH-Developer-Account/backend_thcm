import { prisma } from "@shared/config/prisma";
import logger from "@shared/utils/logger";
import { addMailJob } from "@mail/mail.service";
import type { MailJobPayload } from "@mail/mail.queue";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow mail helpers — every workflow email CCs the initiator (the person
// who created the proposal / onboarding / claim).
//
// WHY this lives in the workflow module and not in mail.service: mail.service
// is a generic queue wrapper and must not know what an "initiator" is.
//
// Split into a pure merge (withInitiatorCc) and an impure lookup
// (resolveInitiatorEmail) so the merge rules are testable without a database,
// and so loops can resolve the initiator once instead of once per mail.
//
// Deliberately NOT applied to guest-credentials mails: they carry a plaintext
// password, and a CC would put it in a second mailbox. Those call addMailJob
// directly.
// ─────────────────────────────────────────────────────────────────────────────

const toAddressList = (value?: string | string[]): string[] =>
  value === undefined ? [] : [value].flat();

// Email addresses are case-insensitive in practice; compare accordingly.
const normalizeAddress = (address: string): string =>
  address.trim().toLowerCase();

export const withInitiatorCc = (
  payload: MailJobPayload,
  initiatorEmail: string | null | undefined,
): MailJobPayload => {
  if (!initiatorEmail) return payload;

  const existingCc = toAddressList(payload.cc);
  const isAlreadyAddressed = [...toAddressList(payload.to), ...existingCc].some(
    (address) => normalizeAddress(address) === normalizeAddress(initiatorEmail),
  );
  if (isAlreadyAddressed) return payload;

  return { ...payload, cc: [...existingCc, initiatorEmail] };
};

export async function resolveInitiatorEmail(
  initiatorUserId: string | null | undefined,
): Promise<string | undefined> {
  if (!initiatorUserId) return undefined;

  try {
    const initiator = await prisma.user.findUnique({
      where: { id: initiatorUserId },
      select: { email: true },
    });
    return initiator?.email || undefined;
  } catch (error: any) {
    // A failed CC lookup must never block the mail itself.
    logger.error(
      `[WorkflowMail] Could not resolve initiator email for user ` +
        `"${initiatorUserId}". Sending without CC. Error: ${error.message}`,
    );
    return undefined;
  }
}

export async function sendWorkflowMail(
  payload: MailJobPayload,
  initiatorUserId: string | null | undefined,
): Promise<void> {
  const initiatorEmail = await resolveInitiatorEmail(initiatorUserId);
  await addMailJob(withInitiatorCc(payload, initiatorEmail));
}

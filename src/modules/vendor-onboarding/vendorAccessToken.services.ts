import crypto from "crypto";
import { prisma } from "@shared/config/prisma";
import { Prisma } from "../../prisma/generated/prisma/client";

// Modeled directly on PasswordResetToken's issue/validate shape —
// same pattern, different subject, per DRY.
type Tx = Prisma.TransactionClient;
export type VendorAccessTokenPurpose = "FORM_ACCESS" | "VIEW_PDF";

export const issueVendorAccessToken = (
  onboardingId: string,
  client: Tx | typeof prisma = prisma, // defaults to the normal client for callers outside a transaction (e.g. resendVendorLink)
  purpose: VendorAccessTokenPurpose = "FORM_ACCESS",
) => {
  const token = crypto.randomBytes(32).toString("hex");
  return client.vendorAccessToken.create({
    data: { onboardingId, token, purpose },
  });
};

export const validateVendorAccessToken = async (token: string) => {
  const record = await prisma.vendorAccessToken.findUnique({
    where: { token },
    include: { onboarding: true },
  });

  if (!record) return null;
  if (record.purpose !== "FORM_ACCESS") return null;
  if (record.used) return null;

  return record;
};

// services/vendorAccessToken.service.ts
export const markVendorAccessTokenUsed = (
  id: string,
  client: Tx | typeof prisma = prisma,
) =>
  client.vendorAccessToken.update({
    where: { id },
    data: { used: true, usedAt: new Date() },
  });

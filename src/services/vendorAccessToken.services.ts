import crypto from "crypto";
import { prisma } from "../config/prisma";

// Modeled directly on PasswordResetToken's issue/validate shape —
// same pattern, different subject, per DRY.
export const issueVendorAccessToken = (onboardingId: string) => {
  const token = crypto.randomBytes(32).toString("hex");
  return prisma.vendorAccessToken.create({
    data: { onboardingId, token },
  });
};

export const validateVendorAccessToken = async (token: string) => {
  const record = await prisma.vendorAccessToken.findUnique({
    where: { token },
    include: { onboarding: true },
  });

  if (!record) return null;
  if (record.used) return null;

  return record;
};

export const markVendorAccessTokenUsed = (id: string) =>
  prisma.vendorAccessToken.update({
    where: { id },
    data: { used: true, usedAt: new Date() },
  });

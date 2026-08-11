import crypto from "crypto";
import { prisma } from "@shared/config/prisma";
import {
  Prisma,
  AccessTokenSubjectType,
} from "../../prisma/generated/prisma/client";

// Generic across every guest-facing app (vendor onboarding, medical claims,
// future ones) — subjectType + subjectId instead of a dedicated FK per app,
// same polymorphic convention already used by WorkflowInstance/ActivityLog.
type Tx = Prisma.TransactionClient;

export const issueAccessToken = (
  subjectType: AccessTokenSubjectType,
  subjectId: string,
  client: Tx | typeof prisma = prisma, // defaults to the normal client for callers outside a transaction
  purpose: string = "FORM_ACCESS",
) => {
  const token = crypto.randomBytes(32).toString("hex");
  return client.accessToken.create({
    data: { subjectType, subjectId, token, purpose },
  });
};

export const validateAccessToken = async (
  token: string,
  subjectType: AccessTokenSubjectType,
) => {
  const record = await prisma.accessToken.findUnique({ where: { token } });

  if (!record) return null;
  if (record.subjectType !== subjectType) return null;
  if (record.purpose !== "FORM_ACCESS") return null;
  if (record.used) return null;

  return record;
};

export const markAccessTokenUsed = (
  id: string,
  client: Tx | typeof prisma = prisma,
) =>
  client.accessToken.update({
    where: { id },
    data: { used: true, usedAt: new Date() },
  });

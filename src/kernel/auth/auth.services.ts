import jwt from "jsonwebtoken";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "@shared/config/prisma";

type AccessTokenPayload = {
  id: string;
  workspaceId: string;
  isSuperAdmin: boolean;
};

export const signAccessToken = (payload: AccessTokenPayload) => {
  return jwt.sign(
    {
      sub: payload.id,
      workspaceId: payload.workspaceId,
      isSuperAdmin: payload.isSuperAdmin,
    },
    process.env.ACCESS_TOKEN_SECRET!,
    { expiresIn: "15m" },
  );
};

export const createRefreshToken = async ({
  userId,
  userAgent,
  ipAddress,
}: {
  userId: string | null;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}) => {
  const tokenId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();

  const tokenHash = await bcrypt.hash(rawToken, 10);

  await prisma.refreshToken.create({
    data: {
      token_id: tokenId,
      token_hash: tokenHash,
      token: `${tokenId}.${rawToken}`,
      user_id: userId as string,
      user_agent: userAgent,
      ip_address: ipAddress,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return `${tokenId}.${rawToken}`;
};

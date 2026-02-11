// jobs/cleanupTokens.ts
import { prisma } from "../config/prisma";

export const cleanupExpiredTokens = async () => {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expires_at: { lt: new Date() } },
        {
          revoked: true,
          created_at: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        }, // Delete revoked tokens older than 30 days
      ],
    },
  });

  console.log(`Cleaned up ${result.count} expired/revoked tokens`);
};

// Run daily
// You can use node-cron or similar

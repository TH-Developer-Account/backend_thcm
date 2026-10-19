import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import type { Prisma } from "../../../prisma/generated/prisma/client";

export async function assertActiveWorkspaceMembers(
  workspaceId: string,
  userIds: string[],
  database: Prisma.TransactionClient = prisma,
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return;

  const members = await database.workspaceUser.findMany({
    where: {
      workspaceId,
      userId: { in: uniqueUserIds },
      user: { is_active: true },
    },
    select: { userId: true },
  });

  const memberIds = new Set(members.map((member) => member.userId));
  const missingUserIds = uniqueUserIds.filter(
    (userId) => !memberIds.has(userId),
  );

  if (missingUserIds.length > 0) {
    throw new ApiError(
      404,
      `These users are not active members of this workspace: ${missingUserIds.join(", ")}`,
    );
  }
}

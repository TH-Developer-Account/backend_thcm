import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { assertActiveWorkspaceMembers } from "../workSpace/workspaceMembership.services";

const personSelect = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
} as const;

export async function listAppAdministrators(
  workspaceId: string,
  appId: string,
) {
  const administrators = await prisma.appAdministrator.findMany({
    where: { workspaceId, appId },
    select: {
      grantedAt: true,
      user: { select: personSelect },
      grantedBy: { select: personSelect },
    },
    orderBy: { grantedAt: "asc" },
  });

  return administrators.map(({ user, grantedBy, grantedAt }) => ({
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    grantedAt,
    grantedBy: {
      id: grantedBy.id,
      firstName: grantedBy.first_name,
      lastName: grantedBy.last_name,
    },
  }));
}

export async function grantAppAdministration(
  workspaceId: string,
  appId: string,
  userId: string,
  grantedById: string,
) {
  await assertActiveWorkspaceMembers(workspaceId, [userId]);

  const membership = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { isSuperAdmin: true },
  });
  // A super admin already administers every app; a row here would outlive a
  // later demotion and silently keep admin rights they were meant to lose.
  if (membership?.isSuperAdmin) {
    throw new ApiError(400, "A super admin already administers every app");
  }

  await prisma.appAdministrator.upsert({
    where: { workspaceId_userId_appId: { workspaceId, userId, appId } },
    create: { workspaceId, userId, appId, grantedById },
    update: {},
  });
}

export async function revokeAppAdministration(
  workspaceId: string,
  appId: string,
  userId: string,
) {
  const { count } = await prisma.appAdministrator.deleteMany({
    where: { workspaceId, appId, userId },
  });
  return count > 0;
}

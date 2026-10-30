import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import type { Prisma } from "../../../prisma/generated/prisma/client";
import { assertActiveWorkspaceMembers } from "../workSpace/workspaceMembership.services";

type AppSlot = { workspaceId: string; appId: string };

// Upserting the (user, app) slot is what keeps other apps safe: this write
// cannot reach a row belonging to any other app.
function upsertAppSlot(
  database: Prisma.TransactionClient,
  slot: AppSlot,
  userId: string,
  profileId: string,
  assignedById: string,
) {
  return database.userProfile.upsert({
    where: { userId_workspaceId_appId: { userId, ...slot } },
    create: { userId, ...slot, profileId, assignedById },
    update: { profileId, assignedById, assignedAt: new Date() },
  });
}

async function findProfileInApp(
  { workspaceId, appId }: AppSlot,
  profileId: string,
) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, workspaceId, appId },
    select: { id: true, appId: true },
  });
  if (!profile) throw new ApiError(404, "Profile not found in this app");
  return profile;
}

export async function assignProfileToUser(
  slot: AppSlot,
  userId: string,
  profileId: string,
  assignedById: string,
) {
  await assertActiveWorkspaceMembers(slot.workspaceId, [userId]);
  await findProfileInApp(slot, profileId);

  return upsertAppSlot(prisma, slot, userId, profileId, assignedById);
}

export async function removeUserFromApp(slot: AppSlot, userId: string) {
  const { count } = await prisma.userProfile.deleteMany({
    where: { userId, ...slot },
  });
  return count > 0;
}

// Counts only — no writes. Lets the FE show "this will assign N users, M
// of them moved off another profile" before the person commits to it.
export async function previewSelectAllAssignment(
  workspaceId: string,
  profileId: string,
  excludeUserIds: string[],
) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, workspaceId },
    select: { id: true, appId: true },
  });
  if (!profile) throw new ApiError(404, "Profile not found");

  const slot = { workspaceId, appId: profile.appId };
  const excludeFilter =
    excludeUserIds.length > 0 ? { userId: { notIn: excludeUserIds } } : {};

  const [willBeAssignedCount, willBeReplacedCount] = await Promise.all([
    prisma.workspaceUser.count({
      where: { workspaceId, user: { is_active: true }, ...excludeFilter },
    }),
    prisma.userProfile.count({
      where: {
        ...slot,
        profileId: { not: profileId },
        user: { is_active: true },
        ...excludeFilter,
      },
    }),
  ]);

  return { willBeAssignedCount, willBeReplacedCount };
}

// Set semantics scoped to one profile: listed users end up holding it (their
// previous profile in this app is replaced), users who held it and are no
// longer listed lose it, and everyone else is left alone.
export async function setProfileAssignees(
  workspaceId: string,
  profileId: string,
  userIds: string[],
  assignedById: string,
) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, workspaceId },
    select: { id: true, appId: true },
  });
  if (!profile) throw new ApiError(404, "Profile not found");

  const slot = { workspaceId, appId: profile.appId };
  const targetUserIds = [...new Set(userIds)];
  await assertActiveWorkspaceMembers(workspaceId, targetUserIds);

  return prisma.$transaction(async (transaction) => {
    const removed = await transaction.userProfile.deleteMany({
      where: { ...slot, profileId, userId: { notIn: targetUserIds } },
    });

    const currentSlots = await transaction.userProfile.findMany({
      where: { ...slot, userId: { in: targetUserIds } },
      select: { userId: true, profileId: true },
    });
    const currentProfileByUser = new Map(
      currentSlots.map((current) => [current.userId, current.profileId]),
    );
    const usersToWrite = targetUserIds.filter(
      (userId) => currentProfileByUser.get(userId) !== profileId,
    );

    if (usersToWrite.length > 0) {
      // Bulk delete-then-insert instead of a per-user upsert loop: every
      // row here is moving to the same profileId, so there's no per-row
      // variation an upsert needs — two set-based queries replace what
      // used to be N sequential round-trips (matters once N is ~2,000).
      await transaction.userProfile.deleteMany({
        where: { ...slot, userId: { in: usersToWrite } },
      });
      await transaction.userProfile.createMany({
        data: usersToWrite.map((userId) => ({
          userId,
          ...slot,
          profileId,
          assignedById,
          assignedAt: new Date(),
        })),
      });
    }

    return {
      assignedCount: usersToWrite.length,
      replacedCount: usersToWrite.filter((userId) =>
        currentProfileByUser.has(userId),
      ).length,
      removedCount: removed.count,
    };
  });
}

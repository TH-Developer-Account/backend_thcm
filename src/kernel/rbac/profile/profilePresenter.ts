import type { Prisma } from "../../../prisma/generated/prisma/client";

export const profileInclude = {
  app: { select: { key: true, name: true } },
  permissions: {
    select: { action: true, module: { select: { key: true, name: true } } },
    orderBy: [{ module: { name: "asc" as const } }, { action: "asc" as const }],
  },
  userProfiles: {
    select: {
      user: {
        select: { id: true, first_name: true, last_name: true, email: true },
      },
    },
  },
  _count: { select: { userProfiles: true } },
} satisfies Prisma.ProfileInclude;

export type ProfileWithRelations = Prisma.ProfileGetPayload<{
  include: typeof profileInclude;
}>;

export function formatProfile(profile: ProfileWithRelations) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    isSystemProfile: profile.isSystemProfile,
    appKey: profile.app.key,
    appName: profile.app.name,
    assignedUserCount: profile._count.userProfiles,
    users: profile.userProfiles.map(({ user }) => ({
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
    })),
    permissions: profile.permissions.map((permission) => ({
      action: permission.action,
      moduleKey: permission.module.key,
      moduleName: permission.module.name,
    })),
  };
}

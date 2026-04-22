import { Prisma } from "../prisma/generated/prisma/client";

export const SALT_ROUNDS = 10;
export const COOLDOWN_SECONDS = 60; // 1 OTP per 60s
export const MAX_ATTEMPTS = 5; // max 5 OTPs
export const WINDOW_SECONDS = 15 * 60; // in 15 minutes

export const profileInclude = {
  permissions: {
    include: {
      module: {
        select: {
          key: true,
          name: true,
          app: { select: { key: true, name: true } },
        },
      },
    },
    orderBy: [
      { module: { app: { key: "asc" as const } } },
      { module: { key: "asc" as const } },
      { action: "asc" as const },
    ],
  },
  userProfiles: {
    select: {
      user: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
        },
      },
    },
  },
  _count: { select: { userProfiles: true } },
} satisfies Prisma.ProfileInclude;

export function formatProfile(profile: any) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    isSystemProfile: profile.isSystemProfile,
    assignedUserCount: profile._count.userProfiles,
    users: profile.userProfiles.map((up: any) => ({
      id: up.user.id,
      firstName: up.user.first_name,
      lastName: up.user.last_name,
      email: up.user.email,
    })),
    permissions: profile.permissions.map((p: any) => ({
      action: p.action,
      appKey: p.module.app.key,
      appName: p.module.app.name,
      moduleKey: p.module.key,
      moduleName: p.module.name,
    })),
  };
}

export const budgetMap: Record<string, { min: number; max: number | null }> = {
  below_20k: { min: 0, max: 20000 },
  "20k_3l": { min: 20000, max: 300000 },
  "3l_6l": { min: 300000, max: 600000 },
  "6l_10l": { min: 600000, max: 1000000 },
  above_10l: { min: 1000000, max: null },
};

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import type { PermissionActionValue } from "./access.types";
import { enabledInWorkspace, findEnabledApp } from "../app/app.service";
import { formatProfile, profileInclude } from "../profile/profilePresenter";
import { Prisma } from "../../../prisma/generated/prisma/client";

type ModulePermissionInput = {
  moduleKey: string;
  action: PermissionActionValue;
};

type ProfileChanges = {
  appKey?: unknown;
  name?: unknown;
  description?: unknown;
  permissions?: unknown;
};

export type ProfileListQuery = {
  appKey?: string;
  searchTerm?: string;
  skip: number;
  take: number;
};

const PERMISSION_ACTIONS: readonly PermissionActionValue[] = ["read", "write"];

function parseProfileName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new ApiError(400, "name is required");
  }
  return name.trim();
}

function parseDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== "string") {
    throw new ApiError(400, "description must be a string");
  }
  return description.trim() || null;
}

// A write without read would let the UI render a module the user cannot see,
// so the API rejects it even though the profile form already prevents it.
function parseModulePermissions(permissions: unknown): ModulePermissionInput[] {
  if (!Array.isArray(permissions)) {
    throw new ApiError(400, "permissions must be an array");
  }

  const uniquePermissions = new Map<string, ModulePermissionInput>();
  for (const permission of permissions) {
    const moduleKey = permission?.moduleKey;
    const action = permission?.action;

    if (typeof moduleKey !== "string" || !moduleKey.trim()) {
      throw new ApiError(400, "Each permission needs a moduleKey");
    }
    if (!PERMISSION_ACTIONS.includes(action)) {
      throw new ApiError(
        400,
        `Invalid action "${action}". Use "read" or "write"`,
      );
    }
    uniquePermissions.set(`${moduleKey}:${action}`, {
      moduleKey: moduleKey.trim(),
      action,
    });
  }

  const parsed = [...uniquePermissions.values()];
  const readableModuleKeys = new Set(
    parsed.filter((p) => p.action === "read").map((p) => p.moduleKey),
  );
  const writeWithoutRead = parsed.find(
    (p) => p.action === "write" && !readableModuleKeys.has(p.moduleKey),
  );
  if (writeWithoutRead) {
    throw new ApiError(
      400,
      `Module "${writeWithoutRead.moduleKey}" has write access without read access`,
    );
  }

  return parsed;
}

async function toPermissionRows(
  appId: string,
  permissions: ModulePermissionInput[],
) {
  const moduleKeys = [...new Set(permissions.map((p) => p.moduleKey))];
  const modules = await prisma.module.findMany({
    where: { appId, key: { in: moduleKeys } },
    select: { id: true, key: true },
  });
  const moduleIdByKey = new Map(modules.map((m) => [m.key, m.id]));

  return permissions.map(({ moduleKey, action }) => {
    const moduleId = moduleIdByKey.get(moduleKey);
    if (!moduleId) {
      throw new ApiError(
        400,
        `Module "${moduleKey}" does not belong to this app`,
      );
    }
    return { moduleId, action };
  });
}

async function assertProfileNameAvailable(
  workspaceId: string,
  appId: string,
  name: string,
  currentProfileId?: string,
): Promise<void> {
  const existing = await prisma.profile.findUnique({
    where: { workspaceId_appId_name: { workspaceId, appId, name } },
    select: { id: true },
  });
  if (existing && existing.id !== currentProfileId) {
    throw new ApiError(
      409,
      `A profile named "${name}" already exists in this app`,
    );
  }
}

async function findWorkspaceProfile(workspaceId: string, profileId: string) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, workspaceId },
    select: {
      id: true,
      appId: true,
      isSystemProfile: true,
      app: { select: { key: true } },
      _count: { select: { userProfiles: true } },
      name: true,
    },
  });
  if (!profile) throw new ApiError(404, "Profile not found");
  return profile;
}

function buildProfileSearchFilter(
  searchTerm: string | undefined,
): Prisma.ProfileWhereInput {
  if (!searchTerm) return {};
  const contains = { contains: searchTerm, mode: "insensitive" as const };
  return {
    OR: [
      { name: contains },
      { description: contains },
      { app: { name: contains } },
      {
        userProfiles: {
          some: {
            user: {
              OR: [
                { first_name: contains },
                { last_name: contains },
                { email: contains },
              ],
            },
          },
        },
      },
    ],
  };
}

export async function listProfiles(
  workspaceId: string,
  manageableAppIds: string[] | null,
  { appKey, searchTerm, skip, take }: ProfileListQuery,
) {
  const where: Prisma.ProfileWhereInput = {
    workspaceId,
    app: { ...enabledInWorkspace(workspaceId), ...(appKey && { key: appKey }) },
    ...(manageableAppIds && { appId: { in: manageableAppIds } }),
    ...buildProfileSearchFilter(searchTerm),
  };

  const [profiles, totalCount] = await Promise.all([
    prisma.profile.findMany({
      where,
      include: profileInclude,
      // id last keeps page boundaries stable when names tie.
      orderBy: [{ app: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
      skip,
      take,
    }),
    prisma.profile.count({ where }),
  ]);

  return { rows: profiles.map(formatProfile), totalCount };
}

export async function getProfile(workspaceId: string, profileId: string) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, workspaceId },
    include: profileInclude,
  });
  if (!profile) throw new ApiError(404, "Profile not found");
  return formatProfile(profile);
}

export async function createProfile(
  workspaceId: string,
  appKey: string,
  input: ProfileChanges,
) {
  const app = await findEnabledApp(workspaceId, appKey);
  const name = parseProfileName(input.name);
  const permissionRows = await toPermissionRows(
    app.id,
    parseModulePermissions(input.permissions ?? []),
  );
  await assertProfileNameAvailable(workspaceId, app.id, name);

  const profile = await prisma.profile.create({
    data: {
      workspaceId,
      appId: app.id,
      name,
      description: parseDescription(input.description),
      permissions: { createMany: { data: permissionRows } },
    },
    include: profileInclude,
  });
  return formatProfile(profile);
}

export async function updateProfile(
  workspaceId: string,
  profileId: string,
  changes: ProfileChanges,
) {
  const existing = await findWorkspaceProfile(workspaceId, profileId);

  if (existing.isSystemProfile) {
    throw new ApiError(403, "System profiles cannot be modified");
  }
  // Moving a profile to another app would silently move every assignee's
  // access with it, so a profile stays in the app it was created for.
  if (changes.appKey !== undefined && changes.appKey !== existing.app.key) {
    throw new ApiError(400, "A profile cannot be moved to another app");
  }

  const name =
    changes.name === undefined ? undefined : parseProfileName(changes.name);
  if (name && name !== existing.name) {
    await assertProfileNameAvailable(
      workspaceId,
      existing.appId,
      name,
      existing.id,
    );
  }

  const permissionRows =
    changes.permissions === undefined
      ? undefined
      : await toPermissionRows(
          existing.appId,
          parseModulePermissions(changes.permissions),
        );

  const profile = await prisma.profile.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name }),
      ...(changes.description !== undefined && {
        description: parseDescription(changes.description),
      }),
      ...(permissionRows && {
        permissions: { deleteMany: {}, createMany: { data: permissionRows } },
      }),
      updated_at: new Date(),
    },
    include: profileInclude,
  });
  return formatProfile(profile);
}

export async function deleteProfile(workspaceId: string, profileId: string) {
  const existing = await findWorkspaceProfile(workspaceId, profileId);

  if (existing.isSystemProfile) {
    throw new ApiError(403, "System profiles cannot be deleted");
  }
  if (existing._count.userProfiles > 0) {
    throw new ApiError(
      409,
      `Cannot delete "${existing.name}": ${existing._count.userProfiles} user(s) still hold it. Reassign or remove them first.`,
    );
  }

  await prisma.profile.delete({ where: { id: existing.id } });
  return existing.name;
}

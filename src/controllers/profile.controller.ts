import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import { Prisma } from "../prisma/generated/prisma/client";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// profile.controller.ts
//
// A Profile is a named bundle of module-level permissions.
// These endpoints are used by the admin UI to manage what each role can do.
//
// Routes:
//   GET    /profiles?workspaceId=x       → list all profiles in the workspace
//   GET    /profiles/:profileId          → single profile with full permissions
//   POST   /profiles                     → create a new profile
//   PUT    /profiles/:profileId          → update name/description + replace permissions
//   DELETE /profiles/:profileId          → delete profile (blocked if users are assigned)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type PermissionInput = {
  action: "read" | "write";
  appKey: string; // e.g. "MAP"
  moduleKey: string; // e.g. "EPC"
};

const VALID_ACTIONS = new Set(["read", "write"]);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER
//
// Resolves an array of { appKey, moduleKey } permission inputs into
// actual moduleIds from the DB. Throws a 400 if any reference is invalid.
//
// We fetch all modules for the workspace in one query instead of one-per-perm.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveModuleIds(
  workspaceId: string,
  permissions: PermissionInput[],
): Promise<{ action: "read" | "write"; moduleId: string }[]> {
  if (permissions.length === 0) return [];

  // Validate action values upfront
  for (const p of permissions) {
    if (!VALID_ACTIONS.has(p.action)) {
      throw new ApiError(
        400,
        `Invalid action "${p.action}". Must be "read" or "write"`,
      );
    }
    if (!p.appKey?.trim() || !p.moduleKey?.trim()) {
      throw new ApiError(400, "Each permission must have appKey and moduleKey");
    }
  }

  // Fetch all modules in the workspace's enabled apps in one query
  const modules = await prisma.module.findMany({
    where: {
      app: {
        workspaceApps: { some: { workspaceId, enabled: true } },
      },
    },
    select: {
      id: true,
      key: true,
      app: { select: { key: true } },
    },
  });

  // Build a lookup map: "APP_KEY:MODULE_KEY" → moduleId
  const moduleMap = new Map(
    modules.map((m) => [`${m.app.key}:${m.key}`, m.id]),
  );

  // Resolve each permission — throw early if any reference is invalid
  return permissions.map((p) => {
    const moduleId = moduleMap.get(`${p.appKey}:${p.moduleKey}`);
    if (!moduleId) {
      throw new ApiError(
        400,
        `Module "${p.moduleKey}" not found under app "${p.appKey}". ` +
          `Make sure it exists and is enabled in this workspace.`,
      );
    }
    return { action: p.action, moduleId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED INCLUDE
// Both getProfiles and getProfileById return the same permission shape.
// ─────────────────────────────────────────────────────────────────────────────

const profileInclude = {
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

function formatProfile(profile: any) {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /profiles?workspaceId=x
//
// Returns all profiles in the workspace with their permission counts.
// Used by the admin UI to show the list of roles.
//
// Response:
// {
//   count: 5,
//   data: [
//     {
//       id, name, description, isSystemProfile,
//       assignedUserCount: 3,
//       permissions: [{ action, appKey, appName, moduleKey, moduleName }]
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

export async function getProfiles(req: Request, res: Response) {
  const { workspaceId } = req.query as Record<string, string>;

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");

  try {
    const profiles = await prisma.profile.findMany({
      where: { workspaceId },
      include: profileInclude,
      orderBy: { created_at: "desc" },
    });

    res.json({ count: profiles.length, data: profiles.map(formatProfile) });
  } catch (error: any) {
    console.error("getProfiles failed:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch profiles", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /profiles/:profileId
//
// Single profile with its full permission list.
// Used when the admin clicks "Edit" on a profile to populate the form.
// ─────────────────────────────────────────────────────────────────────────────

export async function getProfileById(req: Request, res: Response) {
  const { profileId } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId as string },
      include: profileInclude,
    });

    if (!profile) throw new ApiError(404, "Profile not found");

    res.json(formatProfile(profile));
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("getProfileById failed:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch profile", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /profiles
//
// Creates a new profile with its permissions in one transaction.
//
// Payload:
// {
//   "workspaceId": "uuid",
//   "name": "Site Supervisor",
//   "description": "Read+write on MAP, read on HR",  // optional
//   "permissions": [
//     { "action": "read",  "appKey": "MAP", "moduleKey": "EPC" },
//     { "action": "write", "appKey": "MAP", "moduleKey": "EPC" },
//     { "action": "read",  "appKey": "MAP", "moduleKey": "EPF" },
//     { "action": "write", "appKey": "MAP", "moduleKey": "EPF" },
//     { "action": "read",  "appKey": "HR",  "moduleKey": "PAYROLL" }
//   ]
// }
//
// Rules:
//   - name must be unique within the workspace
//   - permissions array can be empty (creates a profile with no access)
//   - each appKey + moduleKey must exist and be enabled in the workspace
// ─────────────────────────────────────────────────────────────────────────────

export async function createProfile(req: Request, res: Response) {
  const { workspaceId, name, description, permissions = [] } = req.body;

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");
  if (!name?.trim()) throw new ApiError(400, "name is required");

  try {
    // Check name is unique in this workspace
    const existing = await prisma.profile.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
      select: { id: true },
    });
    if (existing)
      throw new ApiError(
        409,
        `A profile named "${name}" already exists in this workspace`,
      );

    // Resolve all appKey+moduleKey → moduleId before writing anything
    const resolvedPermissions = await resolveModuleIds(
      workspaceId,
      permissions,
    );

    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.profile.create({
        data: { name, description, workspaceId },
      });

      if (resolvedPermissions.length > 0) {
        await tx.profilePermission.createMany({
          data: resolvedPermissions.map(({ action, moduleId }) => ({
            profileId: created.id,
            action,
            moduleId,
          })),
        });
      }

      return tx.profile.findUnique({
        where: { id: created.id },
        include: profileInclude,
      });
    });

    res.status(201).json({
      message: "Profile created successfully",
      data: formatProfile(profile),
    });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("createProfile failed:", error);
    res
      .status(500)
      .json({ message: "Failed to create profile", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /profiles/:profileId
//
// Updates a profile's name/description and fully replaces its permissions.
// "Fully replaces" means: delete all current permission rows, insert the new
// ones. This is the safest strategy — no stale permissions can linger.
//
// Payload:
// {
//   "name": "Senior Field Engineer",           // optional — omit to keep current
//   "description": "Updated description",       // optional
//   "permissions": [                            // required — replaces ALL permissions
//     { "action": "read",  "appKey": "MAP", "moduleKey": "EPC" },
//     { "action": "write", "appKey": "MAP", "moduleKey": "EPC" },
//     { "action": "read",  "appKey": "HR",  "moduleKey": "PAYROLL" }
//   ]
// }
//
// Important: always send the FULL permissions array you want, not just
// the changes. Whatever you send becomes the new state.
// ─────────────────────────────────────────────────────────────────────────────

export async function updateProfile(req: Request, res: Response) {
  const { profileId } = req.params;
  const { name, description, permissions } = req.body;

  try {
    const existing = await prisma.profile.findUnique({
      where: { id: profileId as string },
      select: {
        id: true,
        workspaceId: true,
        isSystemProfile: true,
        name: true,
      },
    });

    if (!existing) throw new ApiError(404, "Profile not found");
    if (existing.isSystemProfile) {
      throw new ApiError(403, "System profiles cannot be modified");
    }

    // If renaming, check the new name isn't already taken in this workspace
    if (name && name !== existing.name) {
      const nameTaken = await prisma.profile.findUnique({
        where: {
          workspaceId_name: { workspaceId: existing.workspaceId, name },
        },
        select: { id: true },
      });
      if (nameTaken) {
        throw new ApiError(
          409,
          `A profile named "${name}" already exists in this workspace`,
        );
      }
    }

    // Resolve new permissions if provided
    const resolvedPermissions =
      permissions !== undefined
        ? await resolveModuleIds(existing.workspaceId, permissions)
        : null;

    const updated = await prisma.$transaction(async (tx) => {
      // Update name/description if provided
      await tx.profile.update({
        where: { id: profileId as string },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
        },
      });

      // Replace permissions if provided
      if (resolvedPermissions !== null) {
        await tx.profilePermission.deleteMany({
          where: { profileId: profileId as string },
        });

        if (resolvedPermissions.length > 0) {
          await tx.profilePermission.createMany({
            data: resolvedPermissions.map(({ action, moduleId }) => ({
              profileId: profileId as string,
              action,
              moduleId,
            })),
          });
        }
      }

      return tx.profile.findUnique({
        where: { id: profileId as string },
        include: profileInclude,
      });
    });

    res.json({
      message: "Profile updated successfully",
      data: formatProfile(updated),
    });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("updateProfile failed:", error);
    res
      .status(500)
      .json({ message: "Failed to update profile", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /profiles/:profileId
//
// Deletes a profile and all its permission rows.
// Blocked if any users are currently assigned to this profile —
// you must reassign or remove those users first.
//
// No body needed. profileId comes from the URL.
//
// Why block instead of cascade-deleting user assignments?
// Silently removing a user's only profile would leave them with zero access.
// Forcing the admin to explicitly reassign users before deleting a profile
// makes the operation conscious and safe.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteProfile(req: Request, res: Response) {
  const { profileId } = req.params;

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId as string },
      select: {
        id: true,
        name: true,
        isSystemProfile: true,
        _count: { select: { userProfiles: true } },
      },
    });

    if (!profile) throw new ApiError(404, "Profile not found");

    if (profile.isSystemProfile) {
      throw new ApiError(403, "System profiles cannot be deleted");
    }

    if (profile._count.userProfiles > 0) {
      throw new ApiError(
        409,
        `Cannot delete "${profile.name}" — ${profile._count.userProfiles} user(s) are still assigned to it. ` +
          `Reassign or remove them first.`,
      );
    }

    // Permissions cascade-delete via onDelete: Cascade on the relation
    await prisma.profile.delete({ where: { id: profileId as string } });

    res.json({ message: `Profile "${profile.name}" deleted successfully` });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("deleteProfile failed:", error);
    res
      .status(500)
      .json({ message: "Failed to delete profile", error: error.message });
  }
}

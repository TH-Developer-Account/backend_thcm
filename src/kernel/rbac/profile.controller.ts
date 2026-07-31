import { Request, Response } from "express";

import { prisma } from "@shared/config/prisma";
import { formatProfile, profileInclude } from "@shared/utils/contants";

import ApiError from "@shared/utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// profile.controller.ts
//
// A Profile is a named bundle of permissions. Each permission is either:
//   - MODULE scope: { action, appKey, moduleKey }  — access to one module
//   - APP scope:    { action, appKey }              — "admin of this whole
//                     app" (moduleKey omitted entirely). Covers every module
//                     under that app, current and future, via one row.
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
  moduleKey?: string; // e.g. "EPC" — OMIT for an app-scope (admin) row
};

type ResolvedPermissionTarget =
  | { action: "read" | "write"; scope: "MODULE"; moduleId: string }
  | { action: "read" | "write"; scope: "APP"; appId: string };

const VALID_ACTIONS = new Set(["read", "write"]);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER
//
// Resolves an array of permission inputs into actual moduleId/appId targets.
// Throws a 400 if any reference is invalid.
//
// We fetch all modules AND all apps for the workspace in two queries total
// (not one per permission), then resolve every input against those maps.
// ─────────────────────────────────────────────────────────────────────────────

async function resolvePermissionTargets(
  workspaceId: string,
  permissions: PermissionInput[],
): Promise<ResolvedPermissionTarget[]> {
  if (permissions.length === 0) return [];

  // Validate upfront
  for (const p of permissions) {
    if (!VALID_ACTIONS.has(p.action)) {
      throw new ApiError(
        400,
        `Invalid action "${p.action}". Must be "read" or "write"`,
      );
    }
    if (!p.appKey?.trim()) {
      throw new ApiError(400, "Each permission must have an appKey");
    }
  }

  const moduleInputs = permissions.filter((p) => p.moduleKey?.trim());
  const appInputs = permissions.filter((p) => !p.moduleKey?.trim());

  // ── Resolve module-scope inputs ────────────────────────────────────────────
  const modules =
    moduleInputs.length > 0
      ? await prisma.module.findMany({
          where: {
            app: { workspaceApps: { some: { workspaceId, enabled: true } } },
          },
          select: { id: true, key: true, app: { select: { key: true } } },
        })
      : [];

  const moduleMap = new Map(
    modules.map((m) => [`${m.app.key}:${m.key}`, m.id]),
  );

  const resolvedModules: ResolvedPermissionTarget[] = moduleInputs.map((p) => {
    const moduleId = moduleMap.get(`${p.appKey}:${p.moduleKey}`);
    if (!moduleId) {
      throw new ApiError(
        400,
        `Module "${p.moduleKey}" not found under app "${p.appKey}". ` +
          `Make sure it exists and is enabled in this workspace.`,
      );
    }
    return { action: p.action, scope: "MODULE", moduleId };
  });

  // ── Resolve app-scope (admin) inputs ───────────────────────────────────────
  const apps =
    appInputs.length > 0
      ? await prisma.app.findMany({
          where: { workspaceApps: { some: { workspaceId, enabled: true } } },
          select: { id: true, key: true },
        })
      : [];

  const appMap = new Map(apps.map((a) => [a.key, a.id]));

  const resolvedApps: ResolvedPermissionTarget[] = appInputs.map((p) => {
    const appId = appMap.get(p.appKey);
    if (!appId) {
      throw new ApiError(
        400,
        `App "${p.appKey}" not found or not enabled in this workspace.`,
      );
    }
    return { action: p.action, scope: "APP", appId };
  });

  return [...resolvedModules, ...resolvedApps];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /profiles?workspaceId=x
//
// Returns all profiles in the workspace with their permission counts.
// Used by the admin UI to show the list of roles.
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
//   "name": "MAP Admin",
//   "description": "Full admin access to MAP",   // optional
//   "permissions": [
//     { "action": "write", "appKey": "MAP" },                          // ← APP scope: admin of MAP
//     { "action": "read",  "appKey": "HR", "moduleKey": "PAYROLL" }    // ← MODULE scope: HR:PAYROLL only
//   ]
// }
//
// Rules:
//   - name must be unique within the workspace
//   - permissions array can be empty (creates a profile with no access)
//   - a permission with NO moduleKey is an APP-scope (admin) grant for that app
//   - each appKey (and moduleKey, if present) must exist and be enabled in
//     the workspace
// ─────────────────────────────────────────────────────────────────────────────

export async function createProfile(req: Request, res: Response) {
  const { workspaceId, name, description, permissions = [] } = req.body;

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");
  if (!name?.trim()) throw new ApiError(400, "name is required");

  try {
    const existing = await prisma.profile.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
      select: { id: true },
    });
    if (existing)
      throw new ApiError(
        409,
        `A profile named "${name}" already exists in this workspace`,
      );

    const resolvedPermissions = await resolvePermissionTargets(
      workspaceId,
      permissions,
    );

    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.profile.create({
        data: { name, description, workspaceId },
      });

      if (resolvedPermissions.length > 0) {
        await tx.profilePermission.createMany({
          data: resolvedPermissions.map((target) => ({
            profileId: created.id,
            action: target.action,
            scope: target.scope,
            ...(target.scope === "MODULE"
              ? { moduleId: target.moduleId }
              : { appId: target.appId }),
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
//     { "action": "write", "appKey": "MAP" },                       // app-scope (admin)
//     { "action": "read",  "appKey": "HR", "moduleKey": "PAYROLL" } // module-scope
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

    const resolvedPermissions =
      permissions !== undefined
        ? await resolvePermissionTargets(existing.workspaceId, permissions)
        : null;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id: profileId as string },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
        },
      });

      if (resolvedPermissions !== null) {
        await tx.profilePermission.deleteMany({
          where: { profileId: profileId as string },
        });

        if (resolvedPermissions.length > 0) {
          await tx.profilePermission.createMany({
            data: resolvedPermissions.map((target) => ({
              profileId: profileId as string,
              action: target.action,
              scope: target.scope,
              ...(target.scope === "MODULE"
                ? { moduleId: target.moduleId }
                : { appId: target.appId }),
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

    res
      .status(200)
      .json({ message: `Profile "${profile.name}" deleted successfully` });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("deleteProfile failed:", error);
    res
      .status(500)
      .json({ message: "Failed to delete profile", error: error.message });
  }
}

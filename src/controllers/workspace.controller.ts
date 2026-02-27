import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// TYPE HELPERS
// These describe the shape of the JSON body we expect in each request.
// ─────────────────────────────────────────────────────────────────────────────

// One permission entry inside a profile definition.
// Think of this as: "action X is allowed at this scope"
//
// Examples:
//   { action: "read",  scopeType: "WORKSPACE" }
//       → READ on every app/module in the workspace
//
//   { action: "write", scopeType: "APP", appKey: "MAP" }
//       → WRITE on every module inside MAP
//
//   { action: "write", scopeType: "MODULE", appKey: "MAP", moduleKey: "EPC" }
//       → WRITE on the EPC module inside MAP only
type PermissionInput = {
  action: "read" | "write";
  scopeType: "WORKSPACE" | "APP" | "MODULE";
  appKey?: string; // required when scopeType = APP or MODULE
  moduleKey?: string; // required when scopeType = MODULE
};

// One profile definition in the setup/update payload
type ProfileInput = {
  name: string;
  description?: string;
  permissions: PermissionInput[];
};

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSION CHECKER  (the function you call on every API route to gate access)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the user is allowed to perform `action` in the given context.
 *
 * How it works:
 *   1. If the user is a superadmin → always true, no further checks needed.
 *   2. Fetch every ProfilePermission row across all profiles the user holds.
 *   3. Return true if ANY single permission row matches the action + scope.
 *
 * The scope matching rules:
 *   WORKSPACE scope → matches any app/module (it's a blanket pass)
 *   APP scope       → matches only if appId matches the context
 *   MODULE scope    → matches only if moduleId matches the context
 */
export async function can(
  userId: string,
  workspaceId: string,
  action: "read" | "write",
  context: { appId?: string; moduleId?: string } = {},
): Promise<boolean> {
  // Step 1 — Superadmin bypass
  const member = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (member?.isSuperAdmin) return true;

  // Step 2 — Collect all permission rows from all profiles the user holds
  // We join: UserProfile → Profile → ProfilePermission
  const permissions = await prisma.profilePermission.findMany({
    where: {
      profile: {
        userProfiles: { some: { userId, workspaceId } },
      },
    },
  });

  // Step 3 — Check if any permission row covers the requested action + context
  return permissions.some((p) => {
    // The action must match exactly (read vs write)
    if (p.action !== action) return false;

    switch (p.scopeType) {
      // WORKSPACE scope → no appId/moduleId restriction, always passes
      case "WORKSPACE":
        return true;

      // APP scope → must be the same app
      case "APP":
        return p.appId === context.appId;

      // MODULE scope → must be the exact same module
      case "MODULE":
        return p.moduleId === context.moduleId;

      default:
        return false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP WORKSPACE RBAC
// Called once when creating a brand new workspace.
// Creates the workspace, enables apps, creates modules, and creates profiles.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /rbac/setup
 *
 * Expected body:
 * {
 *   workSpaceName: "Tata Hitachi Workspace",
 *   apps: [
 *     {
 *       key: "MAP",
 *       name: "Marketing Activity Planner",
 *       enabled: true,
 *       modules: [
 *         { key: "EPC", name: "Event Planning Calendar" },
 *         { key: "EPF", name: "Event Proposal Form" },
 *         { key: "CRF", name: "Customer Response Form" }
 *       ]
 *     }
 *   ],
 *   profiles: [
 *     {
 *       name: "Field Engineer",
 *       description: "Write access to MAP, read everywhere else",
 *       permissions: [
 *         { action: "read",  scopeType: "WORKSPACE" },
 *         { action: "write", scopeType: "APP", appKey: "MAP" }
 *       ]
 *     }
 *   ]
 * }
 */
export async function setupWorkspaceRBAC(req: Request, res: Response) {
  const { workSpaceName, apps = [], profiles = [] } = req.body;

  if (!workSpaceName) {
    throw new ApiError(400, "workSpaceName is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Step 1: Create the workspace ──────────────────────────────────────
      const workspace = await tx.workspace.create({
        data: { name: workSpaceName },
      });
      const workspaceId = workspace.id;

      // ── Step 2: Create/enable apps and their modules ──────────────────────
      // We build two lookup maps so we can resolve keys → IDs later:
      //   appKeyToId:    "MAP" → "uuid-of-map"
      //   moduleKeyToId: "EPC" → "uuid-of-epc"
      const appKeyToId = new Map<string, string>();
      const moduleKeyToId = new Map<string, string>();

      for (const appInput of apps) {
        const { key, name, enabled = true, modules = [] } = appInput;

        // upsert: create the app globally if it doesn't exist yet,
        // or update its name if it already exists
        const app = await tx.app.upsert({
          where: { key },
          create: { key, name },
          update: { name },
        });
        appKeyToId.set(key, app.id);

        // Enable this app for our new workspace
        await tx.workspaceApp.upsert({
          where: { workspaceId_appId: { workspaceId, appId: app.id } },
          create: { workspaceId, appId: app.id, enabled },
          update: { enabled },
        });

        // Create/update each module under this app
        for (const { key: moduleKey, name: moduleName } of modules) {
          const module = await tx.module.upsert({
            where: { appId_key: { appId: app.id, key: moduleKey } },
            create: { key: moduleKey, name: moduleName, appId: app.id },
            update: { name: moduleName },
          });
          // Store with a composite key so we know which app it belongs to
          moduleKeyToId.set(`${key}:${moduleKey}`, module.id);
        }
      }

      // ── Step 3: Create profiles and their scoped permissions ──────────────
      for (const profileInput of profiles) {
        const { name, description, permissions = [] } = profileInput;

        // Create the profile container (just a name + workspace link)
        const profile = await tx.profile.create({
          data: { name, description, workspaceId },
        });

        // Create each permission entry with its own scope
        for (const perm of permissions) {
          const { action, scopeType, appKey, moduleKey } = perm;

          // Resolve appKey → appId (only needed for APP or MODULE scope)
          const appId = appKey ? appKeyToId.get(appKey) : null;
          if ((scopeType === "APP" || scopeType === "MODULE") && !appId) {
            throw new Error(`App key not found in payload: "${appKey}"`);
          }

          // Resolve moduleKey → moduleId (only needed for MODULE scope)
          const moduleId =
            scopeType === "MODULE" && appKey && moduleKey
              ? moduleKeyToId.get(`${appKey}:${moduleKey}`)
              : null;
          if (scopeType === "MODULE" && !moduleId) {
            throw new Error(
              `Module key not found in payload: "${moduleKey}" under app "${appKey}"`,
            );
          }

          await tx.profilePermission.create({
            data: {
              profileId: profile.id,
              action,
              scopeType,
              appId: appId ?? null,
              moduleId: moduleId ?? null,
            },
          });
        }
      }

      return { success: true, workspaceId };
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error("RBAC setup failed:", error);
    res
      .status(500)
      .json({ message: "Failed to configure RBAC", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE WORKSPACE RBAC
// Used to add/edit apps, modules, and profiles in an existing workspace.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /rbac/update
 *
 * Same body shape as setup, plus a required `workspaceId`.
 * Permissions for each profile are FULLY REPLACED (delete-then-create)
 * so the payload is always the source of truth.
 */
export async function updateWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, workspace, apps = [], profiles = [] } = req.body;

  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Step 1: Optionally rename the workspace ───────────────────────────
      if (workspace?.name) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: workspace.name },
        });
      }

      // ── Step 2: Upsert apps and modules (same as setup) ───────────────────
      const appKeyToId = new Map<string, string>();
      const moduleKeyToId = new Map<string, string>();

      for (const appInput of apps) {
        const { key, name, enabled = true, modules = [] } = appInput;

        const app = await tx.app.upsert({
          where: { key },
          create: { key, name },
          update: { name },
        });
        appKeyToId.set(key, app.id);

        await tx.workspaceApp.upsert({
          where: { workspaceId_appId: { workspaceId, appId: app.id } },
          create: { workspaceId, appId: app.id, enabled },
          update: { enabled },
        });

        for (const { key: moduleKey, name: moduleName } of modules) {
          const module = await tx.module.upsert({
            where: { appId_key: { appId: app.id, key: moduleKey } },
            create: { key: moduleKey, name: moduleName, appId: app.id },
            update: { name: moduleName },
          });
          moduleKeyToId.set(`${key}:${moduleKey}`, module.id);
        }
      }

      // ── Step 3: Upsert profiles and REPLACE their permissions ─────────────
      // "Replace" means: delete all existing permissions for that profile,
      // then insert fresh ones from the payload. This is the safest approach
      // because it avoids stale permissions lingering after an edit.
      for (const profileInput of profiles) {
        const { name, description, permissions = [] } = profileInput;

        // upsert the profile by name (unique within workspace)
        const profile = await tx.profile.upsert({
          where: { workspaceId_name: { workspaceId, name } },
          create: { name, description, workspaceId },
          update: { description },
        });

        // Delete all current permissions for this profile
        await tx.profilePermission.deleteMany({
          where: { profileId: profile.id },
        });

        // Re-insert fresh permissions from the payload
        for (const perm of permissions) {
          const { action, scopeType, appKey, moduleKey } = perm;

          const appId = appKey ? appKeyToId.get(appKey) : null;
          if ((scopeType === "APP" || scopeType === "MODULE") && !appId) {
            throw new Error(`App key not found in payload: "${appKey}"`);
          }

          const moduleId =
            scopeType === "MODULE" && appKey && moduleKey
              ? moduleKeyToId.get(`${appKey}:${moduleKey}`)
              : null;
          if (scopeType === "MODULE" && !moduleId) {
            throw new Error(
              `Module "${moduleKey}" not found under app "${appKey}"`,
            );
          }

          await tx.profilePermission.create({
            data: {
              profileId: profile.id,
              action,
              scopeType,
              appId: appId ?? null,
              moduleId: moduleId ?? null,
            },
          });
        }
      }

      return { workspaceId };
    });

    res.json({ message: "Workspace RBAC updated successfully", data: result });
  } catch (error: any) {
    console.error("RBAC update failed:", error);
    res
      .status(500)
      .json({ message: "RBAC update failed", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE WORKSPACE RBAC ELEMENTS
// Removes a module (and all profiles scoped to it) from a workspace,
// then soft-disables the app if requested.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /rbac/delete
 *
 * Body: { workspaceId, appKey, moduleKey? }
 *
 * If moduleKey is provided → remove that module + its permissions
 * If only appKey is provided → disable the entire app in this workspace
 */
export async function deleteWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, appKey, moduleKey } = req.body;

  if (!workspaceId || !appKey) {
    throw new ApiError(400, "workspaceId and appKey are required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Resolve app
      const app = await tx.app.findUnique({ where: { key: appKey } });
      if (!app) throw new ApiError(404, `App "${appKey}" not found`);

      if (moduleKey) {
        // ── Remove one module ───────────────────────────────────────────────
        const module = await tx.module.findFirst({
          where: { key: moduleKey, appId: app.id },
        });
        if (!module) throw new ApiError(404, `Module "${moduleKey}" not found`);

        // Delete all ProfilePermission rows that target this module.
        // Because of onDelete: Cascade on ProfilePermission → Profile,
        // we only delete the permission rows, NOT the profiles themselves.
        await tx.profilePermission.deleteMany({
          where: { moduleId: module.id },
        });

        // Delete the module itself
        await tx.module.delete({ where: { id: module.id } });
      } else {
        // ── Disable entire app in this workspace ────────────────────────────
        // Remove all permission rows scoped to this app (APP or MODULE scope)
        await tx.profilePermission.deleteMany({
          where: { appId: app.id },
        });

        // Soft-disable: the app still exists globally, just not active here
        await tx.workspaceApp.update({
          where: { workspaceId_appId: { workspaceId, appId: app.id } },
          data: { enabled: false },
        });
      }
    });

    res.status(200).json({ message: "RBAC delete operation successful" });
  } catch (error: any) {
    console.error("RBAC delete failed:", error);
    res
      .status(500)
      .json({ message: "RBAC delete failed", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL WORKSPACES
// Returns every workspace with its apps, modules, and profiles.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /rbac/workspaces
 *
 * Response shape:
 * {
 *   count: number,
 *   data: [
 *     {
 *       id, name,
 *       apps: [{ key, name, enabled, modules: [{ key, name }] }],
 *       profiles: [
 *         {
 *           id, name, description,
 *           permissions: [{ action, scopeType, appKey?, moduleKey? }]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
export async function getAllWorkspaces(req: Request, res: Response) {
  try {
    const workspaces = await prisma.workspace.findMany({
      include: {
        // Fetch apps and their modules
        apps: {
          where: { enabled: true },
          include: {
            app: {
              include: { modules: true },
            },
          },
        },
        // Fetch profiles and their scoped permissions (with app/module names resolved)
        profiles: {
          include: {
            permissions: {
              include: {
                app: { select: { key: true, name: true } },
                module: { select: { key: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const response = workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,

      apps: ws.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,
        modules: wApp.app.modules.map((m) => ({
          key: m.key,
          name: m.name,
        })),
      })),

      profiles: ws.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: profile.description,
        // Each permission shows its action and resolved scope info
        permissions: profile.permissions.map((p) => ({
          action: p.action,
          scopeType: p.scopeType,
          // Show human-readable keys instead of raw IDs
          appKey: p.app?.key ?? null,
          moduleKey: p.module?.key ?? null,
        })),
      })),
    }));

    res.json({ count: response.length, data: response });
  } catch (error: any) {
    console.error("getAllWorkspaces failed:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch workspaces", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /rbac/workspaces/:workspaceId
 */
export async function getWorkspaceById(req: Request, res: Response) {
  const { workspaceId } = req.params;

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");

  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId as string },
      include: {
        apps: {
          where: { enabled: true },
          include: {
            app: { include: { modules: true } },
          },
        },
        profiles: {
          include: {
            permissions: {
              include: {
                app: { select: { key: true, name: true } },
                module: { select: { key: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!ws) throw new ApiError(404, "Workspace not found");

    res.json({
      id: ws.id,
      name: ws.name,
      apps: ws.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,
        modules: wApp.app.modules.map((m) => ({ key: m.key, name: m.name })),
      })),
      profiles: ws.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: profile.description,
        permissions: profile.permissions.map((p) => ({
          action: p.action,
          scopeType: p.scopeType,
          appKey: p.app?.key ?? null,
          moduleKey: p.module?.key ?? null,
        })),
      })),
    });
  } catch (error: any) {
    console.error("getWorkspaceById failed:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch workspace", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGN USER TO WORKSPACE
// Adds a user to a workspace and optionally gives them one or more profiles.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /rbac/assign-user
 *
 * Body:
 * {
 *   userId: string,
 *   workspaceId: string,
 *   profileIds?: string[],   ← array so you can assign multiple profiles at once
 *   isSuperAdmin?: boolean
 * }
 */
export async function assignUserToWorkspace(req: Request, res: Response) {
  const {
    userId,
    workspaceId,
    profileIds = [],
    isSuperAdmin = false,
  } = req.body;

  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Validate that both user and workspace exist ───────────────────────
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new ApiError(404, "User not found");

      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!workspace) throw new ApiError(404, "Workspace not found");

      // ── Add or update workspace membership ───────────────────────────────
      const membership = await tx.workspaceUser.upsert({
        where: { userId_workspaceId: { userId, workspaceId } },
        update: { isSuperAdmin },
        create: { userId, workspaceId, isSuperAdmin },
      });

      // ── Assign each profile to the user ───────────────────────────────────
      // We validate that every profile belongs to this workspace first.
      // A user can hold multiple profiles simultaneously.
      const assignments = [];
      for (const profileId of profileIds) {
        const profile = await tx.profile.findFirst({
          where: { id: profileId, workspaceId },
        });
        if (!profile) {
          throw new ApiError(
            400,
            `Profile "${profileId}" does not belong to this workspace`,
          );
        }

        const assignment = await tx.userProfile.upsert({
          where: {
            userId_workspaceId_profileId: { userId, workspaceId, profileId },
          },
          update: {},
          create: { userId, workspaceId, profileId },
        });
        assignments.push(assignment);
      }

      return { membership, assignments };
    });

    res.json({
      message: "User assigned to workspace successfully",
      data: result,
    });
  } catch (error: any) {
    console.error("assignUserToWorkspace failed:", error);
    res
      .status(500)
      .json({ message: "User assignment failed", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE USER FROM WORKSPACE
// Cleans up all profile assignments then removes workspace membership.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /rbac/remove-user
 *
 * Body: { userId: string, workspaceId: string }
 */
export async function removeUserFromWorkspace(req: Request, res: Response) {
  const { userId, workspaceId } = req.body;

  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Check the user is actually in this workspace
      const membership = await tx.workspaceUser.findUnique({
        where: { userId_workspaceId: { userId, workspaceId } },
      });
      if (!membership)
        throw new ApiError(404, "User is not part of this workspace");

      // Remove all profile assignments for this user in this workspace
      await tx.userProfile.deleteMany({ where: { userId, workspaceId } });

      // Remove workspace membership
      await tx.workspaceUser.delete({
        where: { userId_workspaceId: { userId, workspaceId } },
      });
    });

    res.json({
      message: "User removed from workspace successfully",
      success: true,
    });
  } catch (error: any) {
    console.error("removeUserFromWorkspace failed:", error);
    res.status(500).json({
      message: "Failed to remove user from workspace",
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET USER PERMISSIONS
// Useful for a "what can I do?" API that the frontend calls after login.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /rbac/my-permissions?workspaceId=xxx
 *
 * Returns a flat list of all permission entries the calling user holds,
 * with human-readable scope info. The frontend uses this to show/hide buttons.
 */
export async function getMyPermissions(req: Request, res: Response) {
  // In a real app, userId would come from the JWT (req.user.id).
  // Here we read it from query params for simplicity.
  const { userId, workspaceId } = req.query as Record<string, string>;

  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    // Superadmin shortcut — return a synthetic "can do everything" response
    const member = await prisma.workspaceUser.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!member)
      throw new ApiError(403, "User is not a member of this workspace");

    if (member.isSuperAdmin) {
      return res.json({
        isSuperAdmin: true,
        permissions: [
          {
            action: "write",
            scopeType: "WORKSPACE",
            appKey: null,
            moduleKey: null,
          },
        ],
      });
    }

    // Fetch every ProfilePermission across all profiles this user holds
    const permissions = await prisma.profilePermission.findMany({
      where: {
        profile: {
          userProfiles: { some: { userId, workspaceId } },
        },
      },
      include: {
        app: { select: { key: true, name: true } },
        module: { select: { key: true, name: true } },
      },
    });

    const profiles = await prisma.userProfile.findMany({
      where: { userId, workspaceId },
      include: { profile: { select: { id: true, name: true } } },
    });

    res.json({
      isSuperAdmin: false,
      profiles: profiles.map((up) => ({
        id: up.profile.id,
        name: up.profile.name,
      })),
      permissions: permissions.map((p) => ({
        action: p.action,
        scopeType: p.scopeType,
        appKey: p.app?.key ?? null,
        appName: p.app?.name ?? null,
        moduleKey: p.module?.key ?? null,
        moduleName: p.module?.name ?? null,
      })),
    });
  } catch (error: any) {
    console.error("getMyPermissions failed:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch permissions", error: error.message });
  }
}

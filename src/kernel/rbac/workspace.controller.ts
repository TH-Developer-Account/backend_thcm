import { Request, Response } from "express";
import { Prisma } from "../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// rbac.controller.ts
//
// Responsibilities:
//   - can()              → the permission check function used in middleware
//   - getWorkspaceById   → inspect the full workspace config (apps, modules, profiles)
//   - getMyPermissions   → called after login to populate the frontend permission store
//
// Profile management  → profile.controller.ts
// User assignment     → user.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SHARED INCLUDE + FORMATTER
// Used by getWorkspaceById. Extracted so it can be imported by other
// controllers that need to return workspace data.
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceInclude = {
  apps: {
    where: { enabled: true },
    include: { app: { include: { modules: true } } },
  },
  profiles: {
    include: {
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
      },
    },
  },
} satisfies Prisma.WorkspaceInclude;

export type WorkspaceWithRelations = Prisma.WorkspaceGetPayload<{
  include: typeof workspaceInclude;
}>;

export function formatWorkspace(ws: WorkspaceWithRelations) {
  return {
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
        appKey: p.module.app.key,
        moduleKey: p.module.key,
      })),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// can()
//
// The single permission check function. Used inside requirePermission
// middleware — never called directly from route handlers.
//
// Two DB queries:
//   1. Check if user is a workspace member + superadmin status
//   2. findFirst on ProfilePermission matching action + moduleId
//
// Returns false (not 403) — the caller decides what to do with the result.
// ─────────────────────────────────────────────────────────────────────────────

export async function can(
  userId: string,
  workspaceId: string,
  action: "read" | "write",
  moduleId: string,
): Promise<boolean> {
  const member = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { isSuperAdmin: true },
  });

  if (!member) return false;
  if (member.isSuperAdmin) return true;

  const permission = await prisma.profilePermission.findFirst({
    where: {
      action,
      moduleId,
      profile: { userProfiles: { some: { userId, workspaceId } } },
    },
    select: { id: true },
  });

  return permission !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type ModuleInput = {
  key: string;
  name: string;
};

type AppInput = {
  key: string;
  name: string;
  enabled?: boolean;
  modules: ModuleInput[];
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

function validateApps(apps: AppInput[]) {
  for (const app of apps) {
    if (!app.key?.trim()) throw new ApiError(400, "Each app must have a key");
    if (!app.name?.trim())
      throw new ApiError(400, `App "${app.key}" must have a name`);

    for (const mod of app.modules ?? []) {
      if (!mod.key?.trim())
        throw new ApiError(400, `Module in app "${app.key}" must have a key`);
      if (!mod.name?.trim())
        throw new ApiError(
          400,
          `Module "${mod.key}" in app "${app.key}" must have a name`,
        );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED TRANSACTION HELPER
// Used by both setup and update — upserts apps and their modules.
// Returns "APP_KEY:MODULE_KEY" → moduleId for use by profile.controller.
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertAppsAndModules(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  apps: AppInput[],
): Promise<Map<string, string>> {
  const moduleKeyToId = new Map<string, string>();

  for (const { key, name, enabled = true, modules = [] } of apps) {
    const app = await tx.app.upsert({
      where: { key },
      create: { key, name },
      update: { name },
    });

    await tx.workspaceApp.upsert({
      where: { workspaceId_appId: { workspaceId, appId: app.id } },
      create: { workspaceId, appId: app.id, enabled },
      update: { enabled },
    });

    for (const { key: moduleKey, name: moduleName } of modules) {
      const mod = await tx.module.upsert({
        where: { appId_key: { appId: app.id, key: moduleKey } },
        create: { key: moduleKey, name: moduleName, appId: app.id },
        update: { name: moduleName },
      });
      moduleKeyToId.set(`${key}:${moduleKey}`, mod.id);
    }
  }

  return moduleKeyToId;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP WORKSPACE RBAC   POST /rbac/setup
//
// One-time bootstrap — creates the workspace, apps, modules, and initial
// profiles all in one transaction. Call this once per environment.
//
// After this, use:
//   PUT  /rbac/update        → add new apps or modules
//   POST /profiles           → add new profiles
//   PUT  /profiles/:id       → edit a profile's permissions
//   POST /workspace-users/assign → assign users to the workspace
//
// Payload:
// {
//   "workSpaceName": "Tata Hitachi Workspace",
//   "apps": [
//     {
//       "key": "MAP",
//       "name": "Marketing Activity Planner",
//       "enabled": true,
//       "modules": [
//         { "key": "EPC", "name": "Event Planning Calendar" },
//         { "key": "EPF", "name": "Event Proposal Form" },
//         { "key": "CRF", "name": "Customer Response Form" }
//       ]
//     }
//   ],
//   "profiles": [
//     {
//       "name": "Field Engineer",
//       "description": "Read+write on MAP, read on HR",
//       "permissions": [
//         { "action": "read",  "appKey": "MAP", "moduleKey": "EPC" },
//         { "action": "write", "appKey": "MAP", "moduleKey": "EPC" }
//       ]
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

type PermissionInput = {
  action: "read" | "write";
  appKey: string;
  moduleKey: string;
};

type ProfileInput = {
  name: string;
  description?: string;
  permissions: PermissionInput[];
};

const VALID_ACTIONS = new Set(["read", "write"]);

function validateProfiles(
  profiles: ProfileInput[],
  moduleKeyToId: Map<string, string>,
) {
  for (const profile of profiles) {
    if (!profile.name?.trim())
      throw new ApiError(400, "Each profile must have a name");

    for (const perm of profile.permissions ?? []) {
      if (!VALID_ACTIONS.has(perm.action)) {
        throw new ApiError(
          400,
          `Invalid action "${perm.action}" in profile "${profile.name}". Must be "read" or "write"`,
        );
      }
      if (!perm.appKey?.trim() || !perm.moduleKey?.trim()) {
        throw new ApiError(
          400,
          `Every permission in profile "${profile.name}" must have appKey and moduleKey`,
        );
      }
      if (!moduleKeyToId.has(`${perm.appKey}:${perm.moduleKey}`)) {
        throw new ApiError(
          400,
          `Profile "${profile.name}" references unknown module "${perm.moduleKey}" ` +
            `under app "${perm.appKey}". Make sure it is listed in the apps array.`,
        );
      }
    }
  }
}

export async function setupWorkspaceRBAC(req: Request, res: Response) {
  const { workSpaceName, apps = [], profiles = [] } = req.body;

  if (!workSpaceName?.trim())
    throw new ApiError(400, "workSpaceName is required");
  validateApps(apps);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: workSpaceName },
      });

      const moduleKeyToId = await upsertAppsAndModules(tx, workspace.id, apps);

      // Validate profile permissions reference real modules before writing
      validateProfiles(profiles, moduleKeyToId);

      for (const { name, description, permissions = [] } of profiles) {
        const profile = await tx.profile.create({
          data: { name, description, workspaceId: workspace.id },
        });

        if (permissions.length > 0) {
          await tx.profilePermission.createMany({
            data: permissions.map(
              ({
                action,
                appKey,
                moduleKey,
              }: {
                action: string;
                appKey: string;
                moduleKey: string;
              }) => ({
                profileId: profile.id,
                action,
                moduleId: moduleKeyToId.get(`${appKey}:${moduleKey}`)!,
              }),
            ),
          });
        }
      }

      return { workspaceId: workspace.id };
    });

    res.status(201).json({
      message: "Workspace configured successfully",
      data: result,
    });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("setupWorkspaceRBAC failed:", error);
    res
      .status(500)
      .json({ message: "Failed to configure workspace", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE WORKSPACE RBAC   PUT /rbac/update
//
// Adds or updates apps and modules in an existing workspace.
// Profiles are NOT handled here — use profile.controller for that.
//
// Safe to call with just the new/changed apps — existing apps and modules
// not in the payload are untouched (upsert, not replace).
//
// Typical use cases:
//   - Add a new app with its modules
//   - Add a new module to an existing app
//   - Rename an app or module
//   - Enable or disable an app in the workspace
//
// After adding a new module, go to PUT /profiles/:id to grant access
// to whichever profiles should have it. New modules are never auto-granted.
//
// Payload:
// {
//   "workspaceId": "uuid",
//   "workspace": { "name": "New Name" },   // optional — rename the workspace
//   "apps": [
//     {
//       "key": "FINANCE",
//       "name": "Finance Management",
//       "enabled": true,
//       "modules": [
//         { "key": "BUDGETS",  "name": "Budget Planning" },
//         { "key": "INVOICES", "name": "Invoice Management" }
//       ]
//     }
//   ]
// }
//
// To add a module to an existing app, just include that app in the payload:
// {
//   "workspaceId": "uuid",
//   "apps": [
//     {
//       "key": "MAP",
//       "name": "Marketing Activity Planner",
//       "modules": [
//         { "key": "EPC", "name": "Event Planning Calendar" },  // existing — untouched
//         { "key": "EPF", "name": "Event Proposal Form" },      // existing — untouched
//         { "key": "CRF", "name": "Customer Response Form" },   // existing — untouched
//         { "key": "NEW", "name": "New Module" }                // new — added
//       ]
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

export async function updateWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, workspace, apps = [] } = req.body; // no profiles

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");
  validateApps(apps);

  try {
    await prisma.$transaction(async (tx) => {
      // Optionally rename the workspace
      if (workspace?.name?.trim()) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: workspace.name },
        });
      }

      // Upsert apps and modules — profiles untouched
      await upsertAppsAndModules(tx, workspaceId, apps);
    });

    res.json({ message: "Workspace updated successfully" });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("updateWorkspaceRBAC failed:", error);
    res
      .status(500)
      .json({ message: "Workspace update failed", error: error.message });
  }
}

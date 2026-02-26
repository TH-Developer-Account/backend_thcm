import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

/**
 * Setup RBAC configuration for a newly created workspace.
 *
 * Expected payload shape:
 * {
 *   workSpaceName: string,
 *   apps: [
 *     {
 *       key: string,
 *       name: string,
 *       enabled?: boolean,
 *       modules?: [{ key: string, name: string }]
 *     }
 *   ],
 *   roles: [
 *     {
 *       name: string,
 *       moduleKey: string,
 *       permissions: string[]
 *     }
 *   ]
 * }
 */
export async function setupWorkspaceRBAC(req: Request, res: Response) {
  const { workSpaceName, apps = [], roles = [] } = req.body;

  if (!workSpaceName) {
    throw new ApiError(400, "workspace name is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -----------------------------------------------------
         1️⃣ CREATE WORKSPACE
      ----------------------------------------------------- */
      const workspace = await tx.workspace.create({
        data: { name: workSpaceName },
      });

      const workspaceId = workspace.id;

      /* -----------------------------------------------------
         2️⃣ UPSERT APPS + ENABLE THEM IN WORKSPACE
      ----------------------------------------------------- */
      const moduleKeyToIdMap = new Map<string, string>();

      for (const appInput of apps) {
        const { key, name, enabled = true, modules = [] } = appInput;

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

        /* -----------------------------------------------------
           3️⃣ UPSERT MODULES UNDER APP
        ----------------------------------------------------- */
        for (const moduleInput of modules) {
          const { key: moduleKey, name: moduleName } = moduleInput;

          const module = await tx.module.upsert({
            where: { appId_key: { appId: app.id, key: moduleKey } },
            create: { key: moduleKey, name: moduleName, appId: app.id },
            update: { name: moduleName },
          });

          moduleKeyToIdMap.set(moduleKey, module.id);
        }
      }

      /* -----------------------------------------------------
         4️⃣ CREATE ROLES + PERMISSIONS FOR WORKSPACE
         -----------------------------------------------------
         Each role is scoped to a workspace + module.
         Multiple roles can exist per module (e.g. Admin, Viewer).
      ----------------------------------------------------- */
      for (const roleInput of roles) {
        const { name, moduleKey, permissions = [] } = roleInput;

        const moduleId = moduleKeyToIdMap.get(moduleKey);
        if (!moduleId) {
          throw new Error(`Module not found for key: ${moduleKey}`);
        }

        // Unique constraint: (workspaceId, moduleId, name)
        const role = await tx.role.upsert({
          where: {
            workspaceId_moduleId_name: { workspaceId, moduleId, name },
          },
          create: { name, workspaceId, moduleId },
          update: {},
        });

        /* -----------------------------------------------------
           5️⃣ REPLACE PERMISSIONS FOR ROLE
        ----------------------------------------------------- */
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });

        await tx.rolePermission.createMany({
          data: permissions.map((permission: string) => ({
            roleId: role.id,
            permission,
          })),
        });
      }

      return { success: true, workspaceId };
    });

    res.status(200).json(result);
  } catch (error: any) {
    console.error("RBAC setup failed:", error);
    res
      .status(500)
      .json({ message: "Failed to configure RBAC", error: error.message });
  }
}

/**
 * Update RBAC configuration for an existing workspace.
 *
 * Expected payload:
 * {
 *   workspaceId: string,
 *   workspace?: { name?: string },
 *   apps: [
 *     {
 *       key: string,
 *       name: string,
 *       enabled?: boolean,
 *       modules?: [{ key: string, name: string }]
 *     }
 *   ],
 *   roles: [
 *     {
 *       name: string,
 *       appKey: string,
 *       moduleKey: string,
 *       permissions: string[]
 *     }
 *   ]
 * }
 */
export async function updateWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, workspace, apps = [], roles = [] } = req.body;

  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         1️⃣ UPDATE WORKSPACE METADATA (OPTIONAL)
      ------------------------------------------------- */
      if (workspace?.name) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: workspace.name },
        });
      }

      /* -------------------------------------------------
         2️⃣ UPSERT APPS + ENABLE THEM IN WORKSPACE
      ------------------------------------------------- */
      const appMap: Record<string, string> = {};

      for (const app of apps) {
        const dbApp = await tx.app.upsert({
          where: { key: app.key },
          update: { name: app.name },
          create: { key: app.key, name: app.name },
        });

        appMap[app.key] = dbApp.id;

        await tx.workspaceApp.upsert({
          where: { workspaceId_appId: { workspaceId, appId: dbApp.id } },
          update: { enabled: app.enabled ?? true },
          create: {
            workspaceId,
            appId: dbApp.id,
            enabled: app.enabled ?? true,
          },
        });

        /* -------------------------------------------------
           3️⃣ UPSERT MODULES UNDER APP
        ------------------------------------------------- */
        for (const module of app.modules ?? []) {
          await tx.module.upsert({
            where: { appId_key: { appId: dbApp.id, key: module.key } },
            update: { name: module.name },
            create: { key: module.key, name: module.name, appId: dbApp.id },
          });
        }
      }

      /* -------------------------------------------------
         4️⃣ UPSERT ROLES + REPLACE PERMISSIONS
         -------------------------------------------------
         Role is uniquely identified by (workspaceId, moduleId, name).
         Permissions are fully replaced for exact sync.
      ------------------------------------------------- */
      for (const roleInput of roles) {
        const appId = appMap[roleInput.appKey];
        if (!appId) {
          throw new Error(`App not found in payload: ${roleInput.appKey}`);
        }

        const module = await tx.module.findFirst({
          where: { key: roleInput.moduleKey, appId },
        });
        if (!module) {
          throw new Error(`Module not found: ${roleInput.moduleKey}`);
        }

        const role = await tx.role.upsert({
          where: {
            workspaceId_moduleId_name: {
              workspaceId,
              moduleId: module.id,
              name: roleInput.name,
            },
          },
          update: {},
          create: { name: roleInput.name, workspaceId, moduleId: module.id },
        });

        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });

        await tx.rolePermission.createMany({
          data: roleInput.permissions.map((permission: string) => ({
            roleId: role.id,
            permission,
          })),
        });
      }

      return { workspaceId };
    });

    res.json({ message: "Workspace RBAC updated successfully", data: result });
  } catch (error: any) {
    console.error(error);
    res
      .status(500)
      .json({ message: "RBAC update failed", error: error.message });
  }
}

/**
 * Delete RBAC configuration elements from a workspace.
 *
 * Expected payload:
 * {
 *   workspaceId: string,
 *   appKey: string,
 *   moduleKey: string
 * }
 */
export async function deleteWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, appKey, moduleKey } = req.body;

  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         1️⃣ RESOLVE APP AND MODULE
      ------------------------------------------------- */
      const app = await tx.app.findUnique({ where: { key: appKey } });
      if (!app) throw new Error("App not found");

      const module = await tx.module.findFirst({
        where: { key: moduleKey, appId: app.id },
      });
      if (!module) throw new Error("Module not found");

      /* -------------------------------------------------
         2️⃣ DELETE ALL ROLES FOR THIS MODULE IN WORKSPACE
         -------------------------------------------------
         For each role:
           - Remove user → role assignments (FK safety)
           - Remove role permissions
           - Delete the role
      ------------------------------------------------- */
      const roles = await tx.role.findMany({
        where: { workspaceId, moduleId: module.id },
      });

      const roleIds = roles.map((r) => r.id);

      // Remove user assignments referencing these roles
      await tx.userRole.deleteMany({
        where: { roleId: { in: roleIds } },
      });

      // Remove permission mappings
      await tx.rolePermission.deleteMany({
        where: { roleId: { in: roleIds } },
      });

      // Delete roles themselves
      await tx.role.deleteMany({
        where: { id: { in: roleIds } },
      });

      /* -------------------------------------------------
         3️⃣ DELETE MODULE (GLOBAL ENTITY)
         -------------------------------------------------
         Only do this if module is no longer needed globally.
      ------------------------------------------------- */
      await tx.module.delete({ where: { id: module.id } });

      /* -------------------------------------------------
         4️⃣ DISABLE APP IN WORKSPACE
         -------------------------------------------------
         Remove all user role assignments scoped to roles
         under this app, then soft-disable the app.
      ------------------------------------------------- */

      // Soft disable app in workspace
      await tx.workspaceApp.update({
        where: { workspaceId_appId: { workspaceId, appId: app.id } },
        data: { enabled: false },
      });
    });

    res.status(200).json({ message: "RBAC delete operation successful" });
  } catch (error: any) {
    console.error(error);
    res
      .status(500)
      .json({ message: "RBAC delete failed", error: error.message });
  }
}

/**
 * Fetch all workspaces with their RBAC configuration.
 *
 * Response shape:
 * [
 *   {
 *     id, name,
 *     apps: [{ key, name, enabled, modules: [{ key, name, roles: [{ id, name, permissions }] }] }]
 *   }
 * ]
 */
export async function getAllWorkspaces(req: Request, res: Response) {
  try {
    /* -------------------------------------------------
       Fetch Workspace → WorkspaceApp → App → Module → Role → RolePermission
       Roles are filtered to only those belonging to the workspace.
    ------------------------------------------------- */
    const workspaces = await prisma.workspace.findMany({
      include: {
        apps: {
          where: { enabled: true },
          include: {
            app: {
              include: {
                modules: {
                  include: {
                    roles: {
                      include: { permissions: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const response = workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,

      apps: workspace.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,

        modules: wApp.app.modules.map((module) => ({
          key: module.key,
          name: module.name,

          // Roles are already workspace-scoped via the relation
          roles: module.roles
            .filter((r) => r.workspaceId === workspace.id)
            .map((role) => ({
              id: role.id,
              name: role.name,
              permissions: role.permissions.map((p) => p.permission),
            })),
        })),
      })),
    }));

    res.json({ count: response.length, data: response });
  } catch (error: any) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Failed to fetch workspaces", error: error.message });
  }
}

/**
 * Fetch a single workspace with its complete RBAC configuration.
 */
export async function getWorkspaceById(req: Request, res: Response) {
  const { workspaceId } = req.params;

  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId as string },

      include: {
        apps: {
          where: { enabled: true },
          include: {
            app: {
              include: {
                modules: {
                  include: {
                    roles: {
                      // Filter roles to only this workspace at DB level
                      where: { workspaceId: workspaceId as string },
                      include: { permissions: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!workspace) {
      throw new ApiError(404, "Workspace not found");
    }

    const response = {
      id: workspace.id,
      name: workspace.name,

      apps: workspace.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,

        modules: wApp.app.modules.map((module) => ({
          key: module.key,
          name: module.name,

          roles: module.roles.map((role) => ({
            id: role.id,
            name: role.name,
            permissions: role.permissions.map((p) => p.permission),
          })),
        })),
      })),
    };

    res.json(response);
  } catch (error: any) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Failed to fetch workspace", error: error.message });
  }
}

/**
 * Assign a user to a workspace and optionally attach a role.
 *
 * REQUEST BODY:
 * {
 *   userId: string,
 *   workspaceId: string,
 *   roleId?: string,        ← directly reference the role (no appKey needed)
 *   isSuperAdmin?: boolean
 * }
 */
export async function assignUserToWorkspace(req: Request, res: Response) {
  const { userId, workspaceId, roleId, isSuperAdmin = false } = req.body;

  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         1️⃣ VALIDATE USER AND WORKSPACE
      ------------------------------------------------- */
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new ApiError(404, "User not found");

      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!workspace) throw new ApiError(404, "Workspace not found");

      /* -------------------------------------------------
         2️⃣ ENSURE WORKSPACE MEMBERSHIP
      ------------------------------------------------- */
      const membership = await tx.workspaceUser.upsert({
        where: { userId_workspaceId: { userId, workspaceId } },
        update: { isSuperAdmin },
        create: { userId, workspaceId, isSuperAdmin },
      });

      let assignment = null;

      /* -------------------------------------------------
         3️⃣ OPTIONAL ROLE ASSIGNMENT
         -------------------------------------------------
         Validate that the role belongs to this workspace
         before assigning. No appKey resolution needed —
         role already carries its own workspace + module scope.
      ------------------------------------------------- */
      if (roleId) {
        const role = await tx.role.findFirst({
          where: { id: roleId, workspaceId },
        });

        if (!role) {
          throw new ApiError(400, "Role does not belong to this workspace");
        }

        // PK: (userId, workspaceId, roleId) — users can hold multiple roles
        assignment = await tx.userRole.upsert({
          where: {
            userId_workspaceId_roleId: { userId, workspaceId, roleId },
          },
          update: {},
          create: { userId, workspaceId, roleId },
        });
      }

      return { membership, assignment };
    });

    res.json({
      message: "User assigned to workspace successfully",
      data: result,
    });
  } catch (error: any) {
    console.error(error);
    res
      .status(500)
      .json({ message: "User assignment failed", error: error.message });
  }
}

/**
 * Remove a user from a workspace.
 *
 * Performs full cleanup:
 * 1. Remove all role assignments in the workspace
 * 2. Remove workspace membership
 *
 * REQUEST BODY:
 * { userId: string, workspaceId: string }
 */
export async function removeUserFromWorkspace(req: Request, res: Response) {
  const { userId, workspaceId } = req.body;

  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         1️⃣ VERIFY MEMBERSHIP EXISTS
      ------------------------------------------------- */
      const membership = await tx.workspaceUser.findUnique({
        where: { userId_workspaceId: { userId, workspaceId } },
      });

      if (!membership) {
        throw new ApiError(404, "User is not part of this workspace");
      }

      /* -------------------------------------------------
         2️⃣ REMOVE ALL ROLE ASSIGNMENTS IN WORKSPACE
         -------------------------------------------------
         One delete covers all roles the user holds
         in this workspace, regardless of which app/module
         the role is scoped to.
      ------------------------------------------------- */
      await tx.userRole.deleteMany({ where: { userId, workspaceId } });

      /* -------------------------------------------------
         3️⃣ REMOVE WORKSPACE MEMBERSHIP
      ------------------------------------------------- */
      await tx.workspaceUser.delete({
        where: { userId_workspaceId: { userId, workspaceId } },
      });
    });

    res.json({
      message: "User removed from workspace successfully",
      success: true,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({
      message: "Failed to remove user from workspace",
      error: error.message,
    });
  }
}

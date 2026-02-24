import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

/**
 * Setup RBAC configuration for a newly created workspace.
 *
 * This controller performs the full initial RBAC bootstrap:
 *
 * 1. Creates a workspace
 * 2. Upserts apps and enables them for the workspace
 * 3. Upserts modules under each app
 * 4. Creates/updates profiles per module for the workspace
 * 5. Replaces profile permissions
 *
 * Everything runs inside a single transaction to guarantee consistency.
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
 *   profiles: [
 *     {
 *       moduleKey: string,
 *       permissions: string[]
 *     }
 *   ]
 */
export async function setupWorkspaceRBAC(req: Request, res: Response) {
  const { workSpaceName, apps = [], profiles = [] } = req.body;

  // Validate required input
  if (!workSpaceName) {
    throw new ApiError(400, "workspace name is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -----------------------------------------------------
         1️⃣ CREATE WORKSPACE
         -----------------------------------------------------
         Workspace is the tenant boundary.
         All profiles created later will belong to this workspace.
      ----------------------------------------------------- */
      const workspace = await tx.workspace.create({
        data: {
          name: workSpaceName,
        },
      });

      const workspaceId = workspace.id;

      /* -----------------------------------------------------
         2️⃣ UPSERT APPS + ENABLE THEM IN WORKSPACE
         -----------------------------------------------------
         Apps are global entities.
         WorkspaceApp acts as tenant-level enablement.
      ----------------------------------------------------- */

      // This map helps us resolve moduleId later when creating profiles
      const moduleKeyToIdMap = new Map<string, string>();

      for (const appInput of apps) {
        const { key, name, enabled = true, modules = [] } = appInput;

        /**
         * Upsert ensures:
         * - App is created if not present
         * - App name stays in sync if updated
         */
        const app = await tx.app.upsert({
          where: { key },
          create: { key, name },
          update: { name },
        });

        /**
         * Enable (or update enablement) of app for this workspace.
         * Composite PK: (workspaceId, appId)
         */
        await tx.workspaceApp.upsert({
          where: {
            workspaceId_appId: {
              workspaceId,
              appId: app.id,
            },
          },
          create: {
            workspaceId,
            appId: app.id,
            enabled,
          },
          update: { enabled },
        });

        /* -----------------------------------------------------
           3️⃣ UPSERT MODULES UNDER APP
           -----------------------------------------------------
           Modules are scoped under an app.
           Unique constraint: (appId, key)
        ----------------------------------------------------- */
        for (const moduleInput of modules) {
          const { key: moduleKey, name: moduleName } = moduleInput;

          const module = await tx.module.upsert({
            where: {
              appId_key: {
                appId: app.id,
                key: moduleKey,
              },
            },
            create: {
              key: moduleKey,
              name: moduleName,
              appId: app.id,
            },
            update: {
              name: moduleName,
            },
          });

          /**
           * Store moduleId so profiles can reference modules
           * using frontend-friendly moduleKey.
           */
          moduleKeyToIdMap.set(moduleKey, module.id);
        }
      }

      /* -----------------------------------------------------
         4️⃣ CREATE / UPDATE PROFILES FOR WORKSPACE
         -----------------------------------------------------
         Profiles are workspace-scoped permission bundles
         tied to a specific module.
      ----------------------------------------------------- */

      for (const profileInput of profiles) {
        const { moduleKey, permissions = [] } = profileInput;

        const moduleId = moduleKeyToIdMap.get(moduleKey);

        if (!moduleId) {
          throw new Error(`Module not found for key: ${moduleKey}`);
        }

        /**
         * Upsert profile for this workspace + module.
         * Unique constraint used: (workspaceId, moduleId)
         *
         * NOTE:
         * If later you allow multiple profiles per module,
         * you should include profile name in unique constraint.
         */
        const profile = await tx.profile.upsert({
          where: {
            workspaceId_moduleId: {
              workspaceId,
              moduleId,
            },
          },
          create: {
            workspaceId,
            moduleId,
          },
          update: {},
        });

        /* -----------------------------------------------------
           5️⃣ REPLACE PERMISSIONS FOR PROFILE
           -----------------------------------------------------
           Simpler + safer than diffing.
           Guarantees DB reflects frontend configuration exactly.
        ----------------------------------------------------- */

        await tx.profilePermission.deleteMany({
          where: { profileId: profile.id },
        });

        await tx.profilePermission.createMany({
          data: permissions.map((permission: string) => ({
            profileId: profile.id,
            permission,
          })),
        });
      }

      return { success: true, workspaceId };
    });

    res.status(200).json(result);
  } catch (error: any) {
    console.error("RBAC setup failed:", error);

    res.status(500).json({
      message: "Failed to configure RBAC",
      error: error.message,
    });
  }
}

/**
 * Update RBAC configuration for an existing workspace.
 *
 * This controller is designed for admin-level configuration updates.
 * It safely syncs the workspace RBAC structure with the payload.
 *
 * What this function does:
 *
 * 1. Optionally updates workspace metadata
 * 2. Upserts apps and enables them for the workspace
 * 3. Upserts modules under apps
 * 4. Creates/updates profiles per module for the workspace
 * 5. Replaces profile permissions completely
 *
 * NOTE:
 * - This does NOT delete apps/modules/profiles not present in payload
 * - Payload is treated as source of truth for permissions only
 * - Entire operation runs inside a transaction for consistency
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
 *   profiles: [
 *     {
 *       appKey: string,
 *       moduleKey: string,
 *       permissions: string[]
 *     }
 *   ]
 * }
 */
export async function updateWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId, workspace, apps = [], profiles = [] } = req.body;

  // Validate required input
  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         1️⃣ UPDATE WORKSPACE METADATA (OPTIONAL)
         -------------------------------------------------
         Only updates allowed editable fields.
         Does not recreate or reinitialize RBAC.
      ------------------------------------------------- */
      if (workspace?.name) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: workspace.name },
        });
      }

      /* -------------------------------------------------
         2️⃣ UPSERT APPS + ENABLE THEM IN WORKSPACE
         -------------------------------------------------
         Apps are global entities.
         WorkspaceApp controls whether the app is enabled
         inside this workspace (tenant-level toggle).
      ------------------------------------------------- */

      // Map appKey → appId for quick lookup when processing profiles
      const appMap: Record<string, string> = {};

      for (const app of apps) {
        /**
         * Ensure global app exists or stays updated
         */
        const dbApp = await tx.app.upsert({
          where: { key: app.key },
          update: { name: app.name },
          create: {
            key: app.key,
            name: app.name,
          },
        });

        appMap[app.key] = dbApp.id;

        /**
         * Enable or update enablement for workspace
         * Composite unique: (workspaceId, appId)
         */
        await tx.workspaceApp.upsert({
          where: {
            workspaceId_appId: {
              workspaceId,
              appId: dbApp.id,
            },
          },
          update: { enabled: app.enabled ?? true },
          create: {
            workspaceId,
            appId: dbApp.id,
            enabled: app.enabled ?? true,
          },
        });

        /* -------------------------------------------------
           3️⃣ UPSERT MODULES UNDER APP
           -------------------------------------------------
           Modules are globally defined under an app.
           Unique constraint: (appId, key)
        ------------------------------------------------- */
        for (const module of app.modules ?? []) {
          await tx.module.upsert({
            where: {
              appId_key: {
                appId: dbApp.id,
                key: module.key,
              },
            },
            update: { name: module.name },
            create: {
              key: module.key,
              name: module.name,
              appId: dbApp.id,
            },
          });
        }
      }

      /* -------------------------------------------------
         4️⃣ UPSERT PROFILES + REPLACE PERMISSIONS
         -------------------------------------------------
         Profiles represent permission bundles for a module
         inside a workspace.
         Permissions are fully replaced to ensure exact sync.
      ------------------------------------------------- */
      for (const profile of profiles) {
        const appId = appMap[profile.appKey];

        if (!appId) {
          throw new Error(`App not found in payload: ${profile.appKey}`);
        }

        /**
         * Resolve module belonging to the app
         */
        const module = await tx.module.findFirst({
          where: {
            key: profile.moduleKey,
            appId,
          },
        });

        if (!module) {
          throw new Error(`Module not found: ${profile.moduleKey}`);
        }

        /**
         * Upsert profile scoped to workspace + module
         * Unique constraint: (workspaceId, moduleId)
         */
        const dbProfile = await tx.profile.upsert({
          where: {
            workspaceId_moduleId: {
              workspaceId,
              moduleId: module.id,
            },
          },
          update: {},
          create: {
            workspaceId,
            moduleId: module.id,
          },
        });

        /* -------------------------------------------------
           Replace permissions (source-of-truth sync)
           -------------------------------------------------
           Simpler than diffing
           Prevents stale permissions
        ------------------------------------------------- */
        await tx.profilePermission.deleteMany({
          where: { profileId: dbProfile.id },
        });

        await tx.profilePermission.createMany({
          data: profile.permissions.map((permission: string) => ({
            profileId: dbProfile.id,
            permission,
          })),
        });
      }

      return { workspaceId };
    });

    res.json({
      message: "Workspace RBAC updated successfully",
      data: result,
    });
  } catch (error: any) {
    console.error(error);

    res.status(500).json({
      message: "RBAC update failed",
      error: error.message,
    });
  }
}

/**
 * Delete RBAC configuration elements from a workspace.
 *
 * This controller performs a cascading cleanup based on:
 *   workspaceId + appKey + moduleKey
 *
 * What this function does:
 *
 * 1. Deletes the profile associated with the module in the workspace
 * 2. Deletes all profiles for the module in that workspace
 * 3. Deletes the module (global entity under the app)
 * 4. Removes all user assignments for that app in the workspace
 * 5. Disables the app in the workspace (soft delete)
 *
 * IMPORTANT DESIGN BEHAVIOR:
 * - Modules are global under an app → deleting module affects all workspaces logically
 * - WorkspaceApp is NOT deleted → only disabled
 * - User assignments are always removed before deleting RBAC structures
 * - Entire operation is transactional for consistency
 *
 * Expected payload:
 * {
 *   workspaceId: string,
 *   appKey: string,
 *   moduleKey: string
 * }
 */
export async function deleteWorkspaceRBAC(req: Request, res: Response) {
  const { workspaceId } = req.body;

  // Validate required input
  if (!workspaceId) {
    throw new ApiError(400, "workspaceId and type are required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const { appKey, moduleKey } = req.body;

      /* -------------------------------------------------
         1️⃣ RESOLVE APP AND MODULE
         -------------------------------------------------
         These are required to identify the RBAC scope.
      ------------------------------------------------- */

      const app = await tx.app.findUnique({ where: { key: appKey } });
      if (!app) throw new Error("App not found");

      const module = await tx.module.findFirst({
        where: { key: moduleKey, appId: app.id },
      });
      if (!module) throw new Error("Module not found");

      /* -------------------------------------------------
         2️⃣ DELETE PROFILE FOR THIS MODULE + WORKSPACE
         -------------------------------------------------
         Steps:
         - Remove user assignments referencing the profile
         - Remove permissions
         - Delete the profile record
      ------------------------------------------------- */

      const profile = await tx.profile.findFirst({
        where: {
          workspaceId,
          moduleId: module.id,
        },
      });

      if (!profile) throw new Error("Profile not found");

      // Remove user → profile assignments first (FK safety)
      await tx.userAppProfile.deleteMany({
        where: { profileId: profile.id },
      });

      // Remove permission mappings
      await tx.profilePermission.deleteMany({
        where: { profileId: profile.id },
      });

      // Delete profile itself
      await tx.profile.delete({
        where: { id: profile.id },
      });

      /* -------------------------------------------------
         3️⃣ DELETE ALL PROFILES FOR MODULE IN WORKSPACE
         -------------------------------------------------
         Safety cleanup in case multiple profiles exist
         for the same module (future extensibility).
      ------------------------------------------------- */

      const profiles = await tx.profile.findMany({
        where: {
          workspaceId,
          moduleId: module.id,
        },
      });

      const profileIds = profiles.map((p) => p.id);

      await tx.userAppProfile.deleteMany({
        where: { profileId: { in: profileIds } },
      });

      await tx.profilePermission.deleteMany({
        where: { profileId: { in: profileIds } },
      });

      await tx.profile.deleteMany({
        where: { id: { in: profileIds } },
      });

      /* -------------------------------------------------
         4️⃣ DELETE MODULE (GLOBAL ENTITY)
         -------------------------------------------------
         Removes module definition under the app.
         Should only be done if module is no longer needed.
      ------------------------------------------------- */

      await tx.module.delete({
        where: { id: module.id },
      });

      /* -------------------------------------------------
         5️⃣ DISABLE APP IN WORKSPACE
         -------------------------------------------------
         We DO NOT delete WorkspaceApp record.
         Instead, we disable the app for auditability.
      ------------------------------------------------- */

      // Remove all user assignments for this app in workspace
      await tx.userAppProfile.deleteMany({
        where: {
          workspaceId,
          appId: app.id,
        },
      });

      // Soft disable app in workspace
      await tx.workspaceApp.update({
        where: {
          workspaceId_appId: {
            workspaceId,
            appId: app.id,
          },
        },
        data: { enabled: false },
      });
    });

    res.status(200).json({
      message: "RBAC delete operation successful",
    });
  } catch (error: any) {
    console.error(error);

    res.status(500).json({
      message: "RBAC delete failed",
      error: error.message,
    });
  }
}

/**
 * Fetch all workspaces with their RBAC configuration.
 *
 * What this controller returns:
 * - Workspace basic info
 * - Enabled apps in the workspace
 * - Modules under each app
 * - Profiles configured per module for that workspace
 * - Permissions assigned to each profile
 *
 * Data is transformed into a frontend-friendly structure:
 *
 * [
 *   {
 *     id,
 *     name,
 *     apps: [
 *       {
 *         key,
 *         name,
 *         enabled,
 *         modules: [
 *           {
 *             key,
 *             name,
 *             profiles: [
 *               {
 *                 id,
 *                 permissions: string[]
 *               }
 *             ]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * ]
 *
 * IMPORTANT DESIGN NOTES:
 * - Only enabled apps are returned
 * - Modules are global entities under an app
 * - Profiles are workspace-specific → filtered by workspaceId
 * - This endpoint provides the full RBAC configuration snapshot
 */
export async function getAllWorkspaces(req: Request, res: Response) {
  try {
    /* -------------------------------------------------
       1️⃣ FETCH WORKSPACES WITH FULL RBAC RELATIONS
       -------------------------------------------------
       Includes:
       Workspace
         → WorkspaceApp (enabled only)
         → App
         → Modules
         → Profiles (workspace scoped)
         → Permissions
    ------------------------------------------------- */

    const workspaces = await prisma.workspace.findMany({
      include: {
        apps: {
          where: { enabled: true }, // Only return enabled apps
          include: {
            app: {
              include: {
                module: {
                  include: {
                    profile: {
                      include: {
                        permissions: true,
                      },
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

    /* -------------------------------------------------
       2️⃣ TRANSFORM DB STRUCTURE → FRONTEND STRUCTURE
       -------------------------------------------------
       Why transformation is needed:
       - DB is normalized and relation-heavy
       - Frontend needs hierarchical RBAC config
       - Profiles must be filtered by workspace
    ------------------------------------------------- */

    const response = workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,

      apps: workspace.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,

        modules: wApp.app.module.map((module) => ({
          key: module.key,
          name: module.name,

          // Profiles are workspace-specific → filter required
          profiles: module.profile
            .filter((p) => p.workspaceId === workspace.id)
            .map((profile) => ({
              id: profile.id,
              permissions: profile.permissions.map((p) => p.permission),
            })),
        })),
      })),
    }));

    /* -------------------------------------------------
       3️⃣ SEND RESPONSE
    ------------------------------------------------- */

    res.json({
      count: response.length,
      data: response,
    });
  } catch (error: any) {
    console.error(error);

    res.status(500).json({
      message: "Failed to fetch workspaces",
      error: error.message,
    });
  }
}

/**
 * Fetch a single workspace with its complete RBAC configuration.
 *
 * Returns:
 * - Workspace basic info
 * - Enabled apps in that workspace
 * - Modules under each app
 * - Profiles defined for that workspace + module
 * - Permissions assigned to each profile
 *
 * Frontend response shape:
 * {
 *   id,
 *   name,
 *   apps: [
 *     {
 *       key,
 *       name,
 *       enabled,
 *       modules: [
 *         {
 *           key,
 *           name,
 *           profiles: [
 *             {
 *               id,
 *               permissions: string[]
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 *
 * DESIGN PRINCIPLES:
 * - Workspace is the RBAC boundary (multi-tenant isolation)
 * - Apps are enabled per workspace
 * - Modules belong to apps (global definition)
 * - Profiles are workspace-scoped → filtered at DB level
 * - Permissions are attached to profiles
 */
export async function getWorkspaceById(req: Request, res: Response) {
  const { workspaceId } = req.params;

  /* -------------------------------------------------
     1️⃣ VALIDATION
  ------------------------------------------------- */
  if (!workspaceId) {
    throw new ApiError(400, "workspaceId is required");
  }

  try {
    /* -------------------------------------------------
       2️⃣ FETCH WORKSPACE WITH RBAC RELATIONS
       -------------------------------------------------
       Includes:
       Workspace
         → Enabled WorkspaceApps
         → App
         → Modules
         → Profiles (ONLY for this workspace)
         → Permissions
    ------------------------------------------------- */

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId as string },

      include: {
        apps: {
          where: { enabled: true }, // only active apps
          include: {
            app: {
              include: {
                module: {
                  include: {
                    profile: {
                      // IMPORTANT: profiles are workspace-scoped
                      where: { workspaceId: workspaceId as string },
                      include: {
                        permissions: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    /* -------------------------------------------------
       3️⃣ NOT FOUND HANDLING
    ------------------------------------------------- */
    if (!workspace) {
      throw new ApiError(404, "Workspace not found");
    }

    /* -------------------------------------------------
       4️⃣ TRANSFORM DB STRUCTURE → FRONTEND STRUCTURE
       -------------------------------------------------
       Why transform:
       - DB is normalized
       - Frontend expects hierarchical RBAC tree
       - Removes relation noise
    ------------------------------------------------- */

    const response = {
      id: workspace.id,
      name: workspace.name,

      apps: workspace.apps.map((wApp) => ({
        key: wApp.app.key,
        name: wApp.app.name,
        enabled: wApp.enabled,

        modules: wApp.app.module.map((module) => ({
          key: module.key,
          name: module.name,

          profiles: module.profile.map((profile) => ({
            id: profile.id,
            permissions: profile.permissions.map((p) => p.permission),
          })),
        })),
      })),
    };

    /* -------------------------------------------------
       5️⃣ RESPONSE
    ------------------------------------------------- */

    res.json(response);
  } catch (error: any) {
    console.error(error);

    res.status(500).json({
      message: "Failed to fetch workspace",
      error: error.message,
    });
  }
}

/**
 * Assign a user to a workspace and optionally attach a profile for an app.
 *
 * This controller performs TWO responsibilities atomically:
 *
 * 1️⃣ Ensure workspace membership
 *    - Creates or updates WorkspaceUser record
 *    - Controls tenant access
 *
 * 2️⃣ (Optional) Assign profile for an enabled app
 *    - Only if appKey + profileId are provided
 *    - Ensures profile belongs to:
 *        → same workspace
 *        → module under the given app
 *
 * WHY THIS DESIGN:
 * - Workspace = tenant boundary
 * - App access = enabled per workspace
 * - Profile = permission set scoped to workspace + module
 * - UserAppProfile = actual authorization binding
 *
 * REQUEST BODY:
 * {
 *   userId: string,
 *   workspaceId: string,
 *   appKey?: string,
 *   profileId?: string,
 *   isSuperAdmin?: boolean
 * }
 *
 * RESPONSE:
 * {
 *   membership: WorkspaceUser,
 *   assignment: UserAppProfile | null
 * }
 */
export async function assignUserToWorkspace(req: Request, res: Response) {
  const {
    userId,
    workspaceId,
    appKey,
    profileId,
    isSuperAdmin = false,
  } = req.body;

  /* -------------------------------------------------
     1️⃣ VALIDATION
  ------------------------------------------------- */
  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         2️⃣ VALIDATE USER AND WORKSPACE EXISTENCE
      ------------------------------------------------- */
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new ApiError(404, "User not found");

      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!workspace) throw new ApiError(404, "Workspace not found");

      /* -------------------------------------------------
         3️⃣ ENSURE WORKSPACE MEMBERSHIP
         -------------------------------------------------
         Upsert guarantees:
         ✔ user is added to workspace if new
         ✔ admin flag can be updated
         ✔ idempotent operation
      ------------------------------------------------- */
      const membership = await tx.workspaceUser.upsert({
        where: {
          userId_workspaceId: { userId, workspaceId },
        },
        update: { isSuperAdmin },
        create: {
          userId,
          workspaceId,
          isSuperAdmin,
        },
      });

      let assignment = null;

      /* -------------------------------------------------
         4️⃣ OPTIONAL PROFILE ASSIGNMENT
         -------------------------------------------------
         Only runs if frontend sends:
         ✔ appKey
         ✔ profileId
      ------------------------------------------------- */
      if (appKey && profileId) {
        /* ----- Resolve App ----- */
        const app = await tx.app.findUnique({ where: { key: appKey } });
        if (!app) throw new ApiError(404, "App not found");

        /* ----- Verify App Enabled In Workspace ----- */
        const wsApp = await tx.workspaceApp.findUnique({
          where: {
            workspaceId_appId: {
              workspaceId,
              appId: app.id,
            },
          },
        });

        if (!wsApp || !wsApp.enabled) {
          throw new ApiError(400, "App not enabled in workspace");
        }

        /* ----- Validate Profile Belongs To Workspace + App ----- */
        const profile = await tx.profile.findFirst({
          where: {
            id: profileId,
            workspaceId,
            module: { appId: app.id },
          },
        });

        if (!profile) {
          throw new ApiError(
            400,
            "Profile does not belong to this workspace/app",
          );
        }

        /* ----- Assign Profile To User ----- */
        assignment = await tx.userAppProfile.upsert({
          where: {
            userId_workspaceId_appId: {
              userId,
              workspaceId,
              appId: app.id,
            },
          },
          update: { profileId },
          create: {
            userId,
            workspaceId,
            appId: app.id,
            profileId,
          },
        });
      }

      /* -------------------------------------------------
         5️⃣ RETURN ATOMIC RESULT
      ------------------------------------------------- */
      return {
        membership,
        assignment,
      };
    });

    /* -------------------------------------------------
       6️⃣ SUCCESS RESPONSE
    ------------------------------------------------- */
    res.json({
      message: "User assigned to workspace successfully",
      data: result,
    });
  } catch (error: any) {
    console.error(error);

    res.status(500).json({
      message: "User assignment failed",
      error: error.message,
    });
  }
}

/**
 * Remove a user from a workspace.
 *
 * This operation performs a full cleanup:
 *
 * 1️⃣ Remove all profile assignments in that workspace
 *    → Deletes UserAppProfile records
 *
 * 2️⃣ Remove workspace membership
 *    → Deletes WorkspaceUser record
 *
 * WHY CLEANUP IS REQUIRED:
 * - UserAppProfile depends on workspace access
 * - Prevents orphan authorization records
 * - Maintains tenant isolation
 *
 * REQUEST BODY:
 * {
 *   userId: string,
 *   workspaceId: string
 * }
 *
 * RESPONSE:
 * {
 *   success: true
 * }
 */
export async function removeUserFromWorkspace(req: Request, res: Response) {
  const { userId, workspaceId } = req.body;

  /* -------------------------------------------------
     1️⃣ VALIDATION
  ------------------------------------------------- */
  if (!userId || !workspaceId) {
    throw new ApiError(400, "userId and workspaceId are required");
  }

  try {
    await prisma.$transaction(async (tx) => {
      /* -------------------------------------------------
         2️⃣ VERIFY MEMBERSHIP EXISTS
      ------------------------------------------------- */
      const membership = await tx.workspaceUser.findUnique({
        where: {
          userId_workspaceId: {
            userId,
            workspaceId,
          },
        },
      });

      if (!membership) {
        throw new ApiError(404, "User is not part of this workspace");
      }

      /* -------------------------------------------------
         3️⃣ REMOVE PROFILE ASSIGNMENTS
         -------------------------------------------------
         Deletes all app-level permissions
         granted within this workspace
      ------------------------------------------------- */
      await tx.userAppProfile.deleteMany({
        where: {
          userId,
          workspaceId,
        },
      });

      /* -------------------------------------------------
         4️⃣ REMOVE WORKSPACE MEMBERSHIP
         -------------------------------------------------
         User no longer belongs to tenant
      ------------------------------------------------- */
      await tx.workspaceUser.delete({
        where: {
          userId_workspaceId: {
            userId,
            workspaceId,
          },
        },
      });
    });

    /* -------------------------------------------------
       5️⃣ SUCCESS RESPONSE
    ------------------------------------------------- */
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

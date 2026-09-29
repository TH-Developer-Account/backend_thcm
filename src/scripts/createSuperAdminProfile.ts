/**
 * One-off script: creates the "Super Admin" system profile, grants it read +
 * write on every App, and assigns it to every current workspace super admin.
 *
 * Run manually: npx ts-node src/scripts/createSuperAdminProfile.ts
 *
 * Safe to re-run: every write is create-if-missing, so it also picks up apps
 * added since the last run and super admins promoted since the last run.
 * Additive only — it never removes the profile from anyone.
 */
import { prisma } from "../shared/config/prisma";
import { PermissionAction, ScopeType } from "../prisma/generated/prisma/client";

const SUPER_ADMIN_PROFILE_NAME = "Super Admin";
const SUPER_ADMIN_PROFILE_DESCRIPTION =
  "Full read and write access to every app in the workspace.";

// Throws instead of picking one, so adding a second workspace later breaks
// these one-off scripts loudly rather than provisioning the wrong workspace.
async function findSoleWorkspace() {
  const workspaces = await prisma.workspace.findMany();
  if (workspaces.length !== 1) {
    throw new Error(
      `Expected exactly one workspace, found ${workspaces.length}. Update the script to target a specific workspaceId instead of assuming there's only one.`,
    );
  }
  return workspaces[0];
}

// APP scope means one row per (app, action) instead of one per module, so new
// modules under an existing app are covered without re-running this script.
function buildFullAccessPermissions(profileId: string, appIds: string[]) {
  return appIds.flatMap((appId) =>
    Object.values(PermissionAction).map((action) => ({
      profileId,
      appId,
      action,
      scope: ScopeType.APP,
    })),
  );
}

async function main(): Promise<void> {
  const workspace = await findSoleWorkspace();

  // One transaction so a failure can't leave a profile with partial permissions
  // already assigned to users.
  const result = await prisma.$transaction(async (transaction) => {
    const profile = await transaction.profile.upsert({
      where: {
        workspaceId_name: {
          workspaceId: workspace.id,
          name: SUPER_ADMIN_PROFILE_NAME,
        },
      },
      update: {},
      create: {
        workspaceId: workspace.id,
        name: SUPER_ADMIN_PROFILE_NAME,
        description: SUPER_ADMIN_PROFILE_DESCRIPTION,
        isSystemProfile: true,
      },
    });

    const apps = await transaction.app.findMany({ select: { id: true } });
    const permissions = await transaction.profilePermission.createMany({
      data: buildFullAccessPermissions(
        profile.id,
        apps.map((app) => app.id),
      ),
      skipDuplicates: true,
    });

    const superAdmins = await transaction.workspaceUser.findMany({
      where: { workspaceId: workspace.id, isSuperAdmin: true },
      select: { userId: true },
    });
    const assignments = await transaction.userProfile.createMany({
      data: superAdmins.map(({ userId }) => ({
        userId,
        workspaceId: workspace.id,
        profileId: profile.id,
      })),
      skipDuplicates: true,
    });

    return {
      profileId: profile.id,
      appCount: apps.length,
      permissionsCreated: permissions.count,
      superAdminCount: superAdmins.length,
      assignmentsCreated: assignments.count,
    };
  });

  console.log(
    `Profile "${SUPER_ADMIN_PROFILE_NAME}" (${result.profileId}) ready on workspace "${workspace.name}" (${workspace.id}).`,
  );
  console.log(
    `Permissions: ${result.permissionsCreated} new across ${result.appCount} app(s).`,
  );
  console.log(
    `Assignments: ${result.assignmentsCreated} new of ${result.superAdminCount} super admin(s).`,
  );
  if (result.superAdminCount === 0) {
    console.warn(
      "No super admins found in this workspace — run createSuperAdmin.ts first.",
    );
  }
}

main()
  .catch((err) => {
    console.error("Failed to provision Super Admin profile:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

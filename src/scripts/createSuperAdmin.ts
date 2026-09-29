/**
 * One-off script: creates (or promotes) a super admin user.
 *
 * Run manually: npx ts-node src/scripts/createSuperAdmin.ts
 *
 * Asserts exactly one Workspace exists, since isSuperAdmin is scoped per
 * workspace (WorkspaceUser.isSuperAdmin) rather than being a flag on User
 * directly — see schema.prisma. If you later add a second workspace, this
 * script's "just grab the only one" assumption breaks on purpose (throws)
 * rather than silently picking the wrong one.
 */
import { prisma } from "../shared/config/prisma";

const SUPER_ADMIN_EMAIL = "powerbi.dev@tatahitachi.co.in";
const DEFAULT_PASSWORD = "Welcome@2026";

// First/last name aren't given for this account — using a descriptive
// placeholder since User.first_name/last_name are required fields. Rename
// directly in the DB afterward if you want something different.
const FIRST_NAME = "PowerBI";
const LAST_NAME = "Dev";

async function main(): Promise<void> {
  const workspaces = await prisma.workspace.findMany();
  if (workspaces.length !== 1) {
    throw new Error(
      `Expected exactly one workspace, found ${workspaces.length}. Update this script to target a specific workspaceId instead of assuming there's only one.`,
    );
  }
  const workspace = workspaces[0];

  const user = await prisma.user.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    update: {
      is_active: true,
    },
    create: {
      first_name: FIRST_NAME,
      last_name: LAST_NAME,
      email: SUPER_ADMIN_EMAIL,
      phone_number: null,
      password: DEFAULT_PASSWORD,
      is_active: true,
      is_default_login: true, // forces password reset on first real login
    },
  });

  await prisma.workspaceUser.upsert({
    where: {
      userId_workspaceId: { userId: user.id, workspaceId: workspace.id },
    },
    update: { isSuperAdmin: true },
    create: { userId: user.id, workspaceId: workspace.id, isSuperAdmin: true },
  });

  console.log(
    `Super admin ready: ${SUPER_ADMIN_EMAIL} on workspace "${workspace.name}" (${workspace.id}).`,
  );
  console.log(
    `Default password: ${DEFAULT_PASSWORD} — isDefaultLogin=true, will force a reset on first login.`,
  );
}

main()
  .catch((err) => {
    console.error("Failed to provision super admin:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// scripts/seedDealerAuditApp.ts
//
// Minimal, idempotent (safe to re-run). Creates the App + three Modules,
// and enables the app for one workspace. No Profiles/ProfilePermissions
// here — add those separately once you're ready to grant real users access.

import { prisma } from "../shared/config/prisma";

const WORKSPACE_ID = "c3c20422-856a-4c77-b9fc-cd6a307666be";

const APP_KEY = "DEALER_AUDIT";
const APP_NAME = "Dealer Audit";

const MODULES = [
  { key: "DEALER_AUDIT_ADMIN", name: "Dealer Audit Admin" },
  { key: "DEALER_AUDIT_REVIEW", name: "Dealer Audit Review" },
  { key: "DEALER_AUDIT_DEALER", name: "Dealer Audit Dealer" },
] as const;

async function main() {
  if (!WORKSPACE_ID) {
    throw new Error("WORKSPACE_ID is empty — fill it in before running.");
  }

  const app = await prisma.app.upsert({
    where: { key: APP_KEY },
    update: {},
    create: { key: APP_KEY, name: APP_NAME },
  });
  console.log(`App: ${app.key} (${app.id})`);

  for (const m of MODULES) {
    const module = await prisma.module.upsert({
      where: { appId_key: { appId: app.id, key: m.key } },
      update: {},
      create: { appId: app.id, key: m.key, name: m.name },
    });
    console.log(`Module: ${module.key} (${module.id})`);
  }

  await prisma.workspaceApp.upsert({
    where: { workspaceId_appId: { workspaceId: WORKSPACE_ID, appId: app.id } },
    update: { enabled: true },
    create: { workspaceId: WORKSPACE_ID, appId: app.id, enabled: true },
  });
  console.log(`WorkspaceApp enabled for workspace ${WORKSPACE_ID}`);

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

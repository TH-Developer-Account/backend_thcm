// scripts/migrate-handout-app.ts
//
// One-off, idempotent migration: extracts Handouts from under the "MAP" app
// into its own app ("HANDOUT"), so a user can be granted Handout access
// without needing any MAP profile at all.
//
// What this does NOT do (by design — see chat): it does not clone or carry
// forward any existing Permission grant from a MAP profile onto a new
// Handout profile. Any MAP profile that currently grants the HANDOUT module
// keeps its Permission row, but that row becomes inert the moment the
// module's appId changes below — hasModulePermission/authorize() match a
// grant by (profile.appId, module.appId) agreeing with the resolved appKey,
// and a MAP profile's appId will no longer match "HANDOUT". Nothing reads
// those stale rows after this runs; they are harmless leftovers an admin
// can clean up later, not a correctness risk. Every admin who needs their
// people to keep using Handouts must create a profile under the new
// "HANDOUT" app and grant it manually.
//
// Usage (run exactly once per environment, after deploying code that
// references the HANDOUT_APP = "HANDOUT" constant below):
//   npx ts-node scripts/migrate-handout-app.ts
//
// Safe to re-run: every step is an upsert or a conditional update, so a
// second run after a partial failure just confirms the end state rather
// than erroring or duplicating anything.

import { prisma } from "../shared/config/prisma";
import logger from "../shared/utils/logger";

const OLD_APP_KEY = "MAP";
const NEW_APP_KEY = "HANDOUT";
const NEW_APP_NAME = "Handouts";
const HANDOUT_MODULE_KEY = "HANDOUT";

async function main() {
  const handoutApp = await prisma.app.upsert({
    where: { key: NEW_APP_KEY },
    create: { key: NEW_APP_KEY, name: NEW_APP_NAME },
    update: { name: NEW_APP_NAME },
  });
  logger.info(`[migrate-handout-app] App "${NEW_APP_KEY}" id=${handoutApp.id}`);

  const mapApp = await prisma.app.findUnique({ where: { key: OLD_APP_KEY } });
  if (!mapApp) {
    logger.warn(
      `[migrate-handout-app] No "${OLD_APP_KEY}" app found — nothing to move. Enabling "${NEW_APP_KEY}" for every workspace instead.`,
    );
    const workspaces = await prisma.workspace.findMany({
      select: { id: true },
    });
    await Promise.all(
      workspaces.map((workspace) =>
        prisma.workspaceApp.upsert({
          where: {
            workspaceId_appId: {
              workspaceId: workspace.id,
              appId: handoutApp.id,
            },
          },
          create: {
            workspaceId: workspace.id,
            appId: handoutApp.id,
            enabled: true,
          },
          update: { enabled: true },
        }),
      ),
    );
    return;
  }

  // Enable the new app for every workspace that currently has MAP enabled —
  // the same set of workspaces that could have been using Handouts under
  // MAP up to now.
  const mapWorkspaceApps = await prisma.workspaceApp.findMany({
    where: { appId: mapApp.id, enabled: true },
    select: { workspaceId: true },
  });
  await Promise.all(
    mapWorkspaceApps.map(({ workspaceId }) =>
      prisma.workspaceApp.upsert({
        where: { workspaceId_appId: { workspaceId, appId: handoutApp.id } },
        create: { workspaceId, appId: handoutApp.id, enabled: true },
        update: { enabled: true },
      }),
    ),
  );
  logger.info(
    `[migrate-handout-app] Enabled "${NEW_APP_KEY}" for ${mapWorkspaceApps.length} workspace(s) that had "${OLD_APP_KEY}" enabled.`,
  );

  // Re-parent the single HANDOUT module from MAP to the new app. A plain
  // `update` on the existing row (same Module.id), not a delete+recreate —
  // every Permission row referencing this module's id keeps pointing at a
  // valid module, it just now belongs to a different app (see file header
  // for why that's fine).
  const handoutModule = await prisma.module.findUnique({
    where: { appId_key: { appId: mapApp.id, key: HANDOUT_MODULE_KEY } },
  });
  if (!handoutModule) {
    logger.info(
      `[migrate-handout-app] No "${HANDOUT_MODULE_KEY}" module under "${OLD_APP_KEY}" — already moved, or never created. Nothing to re-parent.`,
    );
    return;
  }

  await prisma.module.update({
    where: { id: handoutModule.id },
    data: { appId: handoutApp.id },
  });
  logger.info(
    `[migrate-handout-app] Re-parented module "${HANDOUT_MODULE_KEY}" (id=${handoutModule.id}) from "${OLD_APP_KEY}" to "${NEW_APP_KEY}".`,
  );

  logger.info(
    '[migrate-handout-app] Done. Existing MAP profiles that granted HANDOUT are now inert for it — create and grant a profile under the new "HANDOUT" app for anyone who needs Handout access.',
  );
}

main()
  .catch((error) => {
    logger.error(`[migrate-handout-app] Failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

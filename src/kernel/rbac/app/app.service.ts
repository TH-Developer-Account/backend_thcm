import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import type { Prisma } from "../../../prisma/generated/prisma/client";

// An app counts only while it is enabled for the workspace, so every
// access-control query filters through this one condition.
export function enabledInWorkspace(workspaceId: string) {
  return { workspaceApps: { some: { workspaceId, enabled: true } } };
}

export async function findEnabledApp(
  workspaceId: string,
  appKey: string,
  database: Prisma.TransactionClient = prisma,
) {
  const app = await database.app.findFirst({
    where: { key: appKey, ...enabledInWorkspace(workspaceId) },
    select: { id: true, key: true, name: true },
  });
  if (!app) {
    throw new ApiError(
      404,
      `App "${appKey}" was not found or is not enabled in this workspace`,
    );
  }
  return app;
}

export function listEnabledApps(
  workspaceId: string,
  manageableAppIds: string[] | null,
) {
  return prisma.app.findMany({
    where: {
      ...enabledInWorkspace(workspaceId),
      ...(manageableAppIds && { id: { in: manageableAppIds } }),
    },
    select: {
      id: true,
      key: true,
      name: true,
      modules: { select: { key: true, name: true }, orderBy: { name: "asc" } },
    },
    orderBy: { name: "asc" },
  });
}

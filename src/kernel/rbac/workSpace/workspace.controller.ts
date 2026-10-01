import type { Request, Response } from "express";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";

import type { Prisma } from "../../../prisma/generated/prisma/client";

type ModuleInput = { key: string; name: string };

type AppInput = {
  key: string;
  name: string;
  enabled?: boolean;
  modules?: ModuleInput[];
};

function validateApps(apps: AppInput[]) {
  if (!Array.isArray(apps)) throw new ApiError(400, "apps must be an array");

  for (const app of apps) {
    if (!app.key?.trim()) throw new ApiError(400, "Each app must have a key");
    if (!app.name?.trim()) {
      throw new ApiError(400, `App "${app.key}" must have a name`);
    }
    for (const appModule of app.modules ?? []) {
      if (!appModule.key?.trim()) {
        throw new ApiError(400, `Module in app "${app.key}" must have a key`);
      }
      if (!appModule.name?.trim()) {
        throw new ApiError(
          400,
          `Module "${appModule.key}" in app "${app.key}" must have a name`,
        );
      }
    }
  }
}

// Upsert, never replace: apps and modules missing from the payload are left
// untouched, so a partial payload cannot delete anything.
async function upsertAppsAndModules(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  apps: AppInput[],
): Promise<void> {
  for (const { key, name, enabled = true, modules = [] } of apps) {
    const app = await transaction.app.upsert({
      where: { key },
      create: { key, name },
      update: { name },
    });

    await transaction.workspaceApp.upsert({
      where: { workspaceId_appId: { workspaceId, appId: app.id } },
      create: { workspaceId, appId: app.id, enabled },
      update: { enabled },
    });

    for (const appModule of modules) {
      await transaction.module.upsert({
        where: { appId_key: { appId: app.id, key: appModule.key } },
        create: { key: appModule.key, name: appModule.name, appId: app.id },
        update: { name: appModule.name },
      });
    }
  }
}

// POST /workspaces/create — bootstrap a new workspace with its apps and
// modules. Profiles are created afterwards through the profile API, because
// each profile now belongs to one app and is managed by that app's admins.
export async function setupWorkspace(request: Request, response: Response) {
  const { workSpaceName, apps = [] } = request.body;

  if (!workSpaceName?.trim()) {
    throw new ApiError(400, "workSpaceName is required");
  }
  validateApps(apps);

  const workspaceId = await prisma.$transaction(async (transaction) => {
    const workspace = await transaction.workspace.create({
      data: { name: workSpaceName.trim() },
    });
    await upsertAppsAndModules(transaction, workspace.id, apps);
    return workspace.id;
  });

  response.status(201).json({
    message: "Workspace configured successfully",
    data: { workspaceId },
  });
}

// POST /workspaces/update — add, rename, enable or disable apps and modules
// in the caller's own workspace.
export async function updateWorkspace(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const { workspace, apps = [] } = request.body;
  validateApps(apps);

  await prisma.$transaction(async (transaction) => {
    if (workspace?.name?.trim()) {
      await transaction.workspace.update({
        where: { id: actor.workspaceId },
        data: { name: workspace.name.trim() },
      });
    }
    await upsertAppsAndModules(transaction, actor.workspaceId, apps);
  });

  response.json({ message: "Workspace updated successfully" });
}

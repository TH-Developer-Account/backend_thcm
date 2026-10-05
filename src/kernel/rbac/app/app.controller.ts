import type { Request, Response } from "express";

import ApiError from "@shared/utils/apiError";
import { getRouteParameter } from "@shared/utils/routerParameter";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";

import { getManageableAppIds } from "../profile/accessPolicy";
import { findEnabledApp, listEnabledApps } from "./app.service";
import {
  grantAppAdministration,
  listAppAdministrators,
  revokeAppAdministration,
} from "./appAdministrator.services";
import {
  assignProfileToUser,
  removeUserFromApp,
} from "../profile/profileAssignment.service";

async function resolveRouteApp(request: Request) {
  const actor = getAuthenticatedUser(request);
  const app = await findEnabledApp(
    actor.workspaceId,
    getRouteParameter(request, "appKey"),
  );
  return {
    actor,
    app,
    slot: { workspaceId: actor.workspaceId, appId: app.id },
  };
}

export async function listApps(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const apps = await listEnabledApps(
    actor.workspaceId,
    getManageableAppIds(actor),
  );
  response.json({
    data: apps.map((app) => ({
      appId: app.id,
      appKey: app.key,
      appName: app.name,
      modules: app.modules,
    })),
  });
}

export async function listAdministrators(request: Request, response: Response) {
  const { actor, app } = await resolveRouteApp(request);
  const administrators = await listAppAdministrators(actor.workspaceId, app.id);
  response.json({ data: administrators });
}

export async function grantAdministrator(request: Request, response: Response) {
  const { actor, app } = await resolveRouteApp(request);
  await grantAppAdministration(
    actor.workspaceId,
    app.id,
    getRouteParameter(request, "userId"),
    actor.id,
  );
  response.json({ message: `User is now an administrator of ${app.name}` });
}

export async function revokeAdministrator(
  request: Request,
  response: Response,
) {
  const { actor, app } = await resolveRouteApp(request);
  const revoked = await revokeAppAdministration(
    actor.workspaceId,
    app.id,
    getRouteParameter(request, "userId"),
  );
  if (!revoked) {
    throw new ApiError(404, `User is not an administrator of ${app.name}`);
  }
  response.json({ message: `Administrator access to ${app.name} removed` });
}

export async function assignUserProfile(request: Request, response: Response) {
  const { actor, slot } = await resolveRouteApp(request);
  const { profileId } = request.body;
  if (typeof profileId !== "string" || !profileId) {
    throw new ApiError(400, "profileId is required");
  }

  const assignment = await assignProfileToUser(
    slot,
    getRouteParameter(request, "userId"),
    profileId,
    actor.id,
  );
  response.json({ message: "Profile assigned", data: assignment });
}

export async function removeUserProfile(request: Request, response: Response) {
  const { app, slot } = await resolveRouteApp(request);
  const removed = await removeUserFromApp(
    slot,
    getRouteParameter(request, "userId"),
  );
  if (!removed) {
    throw new ApiError(404, `User has no profile in ${app.name}`);
  }
  response.json({ message: `Access to ${app.name} removed` });
}

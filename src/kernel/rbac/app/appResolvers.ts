import type { Request } from "express";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { getRouteParameter } from "@shared/utils/routerParameter";

// Each app-scoped route knows the target app from a different place (URL,
// body, or the profile being edited). A resolver per source lets one guard,
// requireAppAdministration, serve all of them.
export type AppKeyResolver = (
  request: Request,
  workspaceId: string,
) => Promise<string>;

export function appKeyFromRouteParameter(
  parameterName: string,
): AppKeyResolver {
  return async (request) => getRouteParameter(request, parameterName);
}

export function appKeyFromBody(fieldName: string): AppKeyResolver {
  return async (request) => {
    const value = request.body?.[fieldName];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, `"${fieldName}" is required`);
    }
    return value.trim();
  };
}

export function appKeyFromProfileParameter(
  parameterName: string,
): AppKeyResolver {
  return async (request, workspaceId) => {
    const profile = await prisma.profile.findFirst({
      where: { id: getRouteParameter(request, parameterName), workspaceId },
      select: { app: { select: { key: true } } },
    });
    if (!profile) throw new ApiError(404, "Profile not found");

    return profile.app.key;
  };
}

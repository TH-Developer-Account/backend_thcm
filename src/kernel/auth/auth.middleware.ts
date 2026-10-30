import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { buildUserPermissions } from "@rbac/profile/userPermission";
import {
  canAccessAdministration,
  hasModulePermission,
  isAppAdministrator,
  isSuperAdmin,
} from "@rbac/profile/accessPolicy";
import type {
  AccessActor,
  PermissionActionValue,
} from "@rbac/profile/access.types";
import type { AppKeyResolver } from "@rbac/app/appResolvers";

function readAccessToken(request: Request): string | undefined {
  const authorizationHeader = request.headers.authorization;
  if (authorizationHeader?.startsWith("Bearer ")) {
    return authorizationHeader.split(" ")[1];
  }
  // EventSource cannot send headers, so SSE clients pass the token in the query.
  return request.query.token as string | undefined;
}

// Permissions are rebuilt on every request (not read from the JWT) so that a
// revoked profile or admin right takes effect on the user's very next call.
export const requireAuth = async (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  try {
    const token = readAccessToken(request);
    if (!token) throw new ApiError(401, "No token provided");

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      sub: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        is_active: true,
        workspaceUsers: { select: { workspaceId: true } },
      },
    });

    if (!user || !user.is_active) {
      throw new ApiError(401, "User not authorized");
    }

    // Single-workspace system today; a multi-workspace UI would pass the
    // workspace explicitly (e.g. an X-Workspace-Id header) instead.
    const membership = user.workspaceUsers[0];
    if (!membership) {
      throw new ApiError(403, "User does not belong to any workspace");
    }

    const access = await buildUserPermissions(user.id, membership.workspaceId);

    request.user = {
      id: user.id,
      email: user.email,
      workspaceId: membership.workspaceId,
      ...access,
    };

    next();
  } catch (error) {
    response.sendStatus(401);
  }
};

export function getAuthenticatedUser(request: Request): Express.User {
  if (!request.user) throw new ApiError(401, "Not authenticated");
  return request.user;
}

function requireActor(
  isAllowed: (actor: AccessActor) => boolean,
  deniedMessage: string,
): RequestHandler {
  return (request, _response, next) => {
    try {
      if (!isAllowed(getAuthenticatedUser(request))) {
        throw new ApiError(403, deniedMessage);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireSuperAdmin = requireActor(
  isSuperAdmin,
  "This action requires super admin access",
);

export const requireAdministrationAccess = requireActor(
  canAccessAdministration,
  "This action requires administrator access",
);

export function authorize(
  appKey: string,
  moduleKey: string,
  action: PermissionActionValue,
): RequestHandler {
  return requireActor(
    (actor) => hasModulePermission(actor, action, appKey, moduleKey),
    "You do not have access to this module",
  );
}

export function requireAppAdministration(
  resolveAppKey: AppKeyResolver,
): RequestHandler {
  return async (request, _response, next) => {
    try {
      const actor = getAuthenticatedUser(request);
      const appKey = await resolveAppKey(request, actor.workspaceId);

      if (!isAppAdministrator(actor, appKey)) {
        throw new ApiError(403, `You do not administer the ${appKey} app`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

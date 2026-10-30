import type { Request, Response } from "express";

import ApiError from "@shared/utils/apiError";
import { parsePaginationParams } from "@shared/utils/helpers";
import { getRouteParameter } from "@shared/utils/routerParameter";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";

import { getManageableAppIds } from "./accessPolicy";
import * as profileService from "./profile.services";
import {
  previewSelectAllAssignment,
  setProfileAssignees,
} from "./profileAssignment.service";
import { listActiveWorkspaceMemberIds } from "../workSpace/workspaceMembership.services";

function optionalQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function listProfiles(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const { reqPageIndex, reqPageSize } = parsePaginationParams(
    optionalQueryString(request.query.pageIndex),
    optionalQueryString(request.query.pageSize),
  );

  const { rows, totalCount } = await profileService.listProfiles(
    actor.workspaceId,
    getManageableAppIds(actor),
    {
      appKey: optionalQueryString(request.query.appKey),
      searchTerm: optionalQueryString(request.query.search),
      skip: reqPageIndex * reqPageSize,
      take: reqPageSize,
    },
  );

  response.json({
    rows,
    totalCount,
    pageIndex: reqPageIndex,
    pageSize: reqPageSize,
  });
}

export async function getProfile(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const profile = await profileService.getProfile(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
  );
  response.json(profile);
}

export async function createProfile(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const profile = await profileService.createProfile(
    actor.workspaceId,
    request.body.appKey,
    request.body,
  );
  response
    .status(201)
    .json({ message: "Profile created successfully", data: profile });
}

export async function updateProfile(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const profile = await profileService.updateProfile(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
    request.body,
  );
  response.json({ message: "Profile updated successfully", data: profile });
}

export async function deleteProfile(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const profileName = await profileService.deleteProfile(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
  );
  response.json({ message: `Profile "${profileName}" deleted successfully` });
}

// Resolves either request shape into a concrete id list before it ever
// reaches setProfileAssignees — that function doesn't need to know or
// care how the caller decided who's being assigned.
async function resolveAssignmentTargetUserIds(
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<string[]> {
  if (body.selectAll === true) {
    const excludeUserIds = Array.isArray(body.excludeUserIds)
      ? body.excludeUserIds.filter((id): id is string => typeof id === "string")
      : [];
    return listActiveWorkspaceMemberIds(workspaceId, excludeUserIds);
  }

  const { userIds } = body;
  if (
    !Array.isArray(userIds) ||
    userIds.some((userId) => typeof userId !== "string")
  ) {
    throw new ApiError(
      400,
      "Send either { userIds: string[] } or { selectAll: true, excludeUserIds?: string[] }",
    );
  }
  return userIds;
}

export async function updateProfileAssignees(
  request: Request,
  response: Response,
) {
  const actor = getAuthenticatedUser(request);
  const targetUserIds = await resolveAssignmentTargetUserIds(
    actor.workspaceId,
    request.body,
  );

  const result = await setProfileAssignees(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
    targetUserIds,
    actor.id,
  );
  response.json({ message: "Profile assignments updated", data: result });
}

export async function previewProfileAssignment(
  request: Request,
  response: Response,
) {
  const actor = getAuthenticatedUser(request);
  const excludeUserIds =
    optionalQueryString(request.query.excludeUserIds)
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];

  const preview = await previewSelectAllAssignment(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
    excludeUserIds,
  );
  response.json(preview);
}

import type { Request, Response } from "express";

import ApiError from "@shared/utils/apiError";
import { getRouteParameter } from "@shared/utils/routerParameter";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";

import { getManageableAppIds } from "./accessPolicy";
import * as profileService from "../profile/profile.services";
import { setProfileAssignees } from "./profileAssignment.service";

function optionalQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function listProfiles(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const profiles = await profileService.listProfiles(
    actor.workspaceId,
    getManageableAppIds(actor),
    optionalQueryString(request.query.appKey),
  );
  response.json({ count: profiles.length, data: profiles });
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

export async function updateProfileAssignees(
  request: Request,
  response: Response,
) {
  const actor = getAuthenticatedUser(request);
  const { userIds } = request.body;
  if (
    !Array.isArray(userIds) ||
    userIds.some((userId) => typeof userId !== "string")
  ) {
    throw new ApiError(
      400,
      "userIds must be an array of user ids (send [] to clear)",
    );
  }

  const result = await setProfileAssignees(
    actor.workspaceId,
    getRouteParameter(request, "profileId"),
    userIds,
    actor.id,
  );
  response.json({ message: "Profile assignments updated", data: result });
}

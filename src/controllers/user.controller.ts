import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { buildUserPermissions } from "../utils/userPermission";
import { formatProfile, profileInclude } from "../utils/contants";

// Extend Request interface
declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
    };
  }
}

export const getUsers = async (req: Request, res: Response) => {
  const users = await prisma.user.findMany();
  res.status(200).json(users);
};

export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw new ApiError(401, "Unauthorized");
    }

    // Fetch user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone_number: true,
        is_active: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    if (!user.is_active) {
      throw new ApiError(403, "Account is inactive");
    }

    // Load workspace membership (single workspace system)
    const workspace = await prisma.workspaceUser.findFirst({
      where: { userId: user.id },
      select: {
        workspaceId: true,
        isSuperAdmin: true,
      },
    });

    if (!workspace) {
      throw new ApiError(403, "User not assigned to workspace");
    }

    // 🔥 Load module-level permissions
    const permissions = await buildUserPermissions(
      user.id,
      workspace.workspaceId,
    );

    res.status(200).json({
      user,
      workspaceId: workspace.workspaceId,
      permissions,
    });
  } catch (error) {
    next(error);
  }
};

export async function getByDEmployees(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const response = await axios.get(
      "https://my347749.sapbydesign.com/sap/byd/odata/cc_home_analytics.svc/RPZD655449B1A636628E3B774QueryResults?$select=Ts1ANs627E6567A30CCE2,CCOMPANY_UUID,TCOMPANY_UUID,CY4M9FABQY_37FB16C540,Ts1ANsB16243B33AE70B6,CEMPLOYEE_UUID,TEMPLOYEE_UUID,CWA_START_DATE,Cs1ANsDEEFA17BFFCF618,Ts1ANsA4889B6AD57D2F6,Ts1ANs188C5F1E104E8F1,CEE_PRIV_MAIL,CEE_PRIV_MOBILE,Ts1ANs564DE5EF7E2FC4D,Ts1ANsE819527096E9697,CWA_END_DATE,Ts1ANs6AE1BC19D4E7A30,Ts1ANsE1AB739751277B4&$top=10&$format=json",
      {
        auth: {
          username: "7000035",
          password: "Welcome@1234",
        },
        headers: {
          Accept: "application/json",
        },
      },
    );

    const results = response.data.d?.results ?? response.data;

    res.json(results);
  } catch (error) {
    next(error);
  }
}

export async function getC4CEmployees(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const response = await axios.get(
      "https://my349841.crm.ondemand.com/sap/c4c/odata/ana_businessanalytics_analytics.svc/RPZ4EA7D91CAB6B391554B8F0QueryResults?$select=TSTAFFED_OC_UUID,CWRKADRS_EMAIL,CEE_UUID,CEE_GIVEN_NAME,TJOB_UUID,CEE_FAMILY_NAME,CRESP_MANAGER_UUID,TRESP_MANAGER_UUID,CWRKADRS_FRM_MOBILE,CEMPL_TYPE_START_DATE,CEMPL_TYPE_END_DATE&$top=10&$format=json",
      {
        auth: {
          username: "7000030",
          password: "Welcome@1234",
        },
        headers: {
          Accept: "application/json",
        },
      },
    );

    const results = response.data.d?.results ?? response.data;

    res.json(results);
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /workspace-users/profiles
//
// Assigns a single profile to one or many users in one call.
//
// Payload:
// {
//   "userIds":   ["uuid-1", "uuid-2", "uuid-3"],
//   "profileId": "uuid"    ← send null to clear the profile for all userIds
// }
// ─────────────────────────────────────────────────────────────────────────────

export async function assignUserProfiles(req: Request, res: Response) {
  const { userIds, profileId, workspaceId } = req.body as {
    userIds: string[];
    profileId: string | null;
    workspaceId: string;
  };

  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new ApiError(400, "userIds must be a non-empty array");
  }
  if (profileId === undefined) {
    throw new ApiError(400, "profileId is required (send null to clear)");
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Validate all userIds are workspace members in one query
      const members = await tx.workspaceUser.findMany({
        where: { workspaceId, userId: { in: userIds } },
        select: { userId: true },
      });

      if (members.length !== userIds.length) {
        const found = new Set(members.map((m) => m.userId));
        const missing = userIds.filter((id) => !found.has(id));
        throw new ApiError(
          404,
          `These users are not in the workspace: ${missing.join(", ")}`,
        );
      }

      // Validate profileId belongs to this workspace
      if (profileId !== null) {
        const profile = await tx.profile.findFirst({
          where: { id: profileId, workspaceId },
          select: { id: true },
        });
        if (!profile)
          throw new ApiError(404, "Profile not found in this workspace");
      }

      // Clear all current assignments for these users
      await tx.userProfile.deleteMany({
        where: { workspaceId, userId: { in: userIds } },
      });

      // Assign the new profile if not null
      if (profileId !== null) {
        await tx.userProfile.createMany({
          data: userIds.map((userId) => ({ userId, workspaceId, profileId })),
        });
      }
    });

    let profileData = null;

    if (profileId) {
      const profile = await prisma.profile.findFirst({
        where: { id: profileId, workspaceId },
        include: profileInclude,
      });

      profileData = profile ? formatProfile(profile) : null;
    }

    const message = profileId
      ? `Profile assigned to ${userIds.length} user(s) successfully`
      : `Profile cleared for ${userIds.length} user(s) successfully`;

    res.status(200).json({ message, profile: profileData });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("assignUserProfiles failed:", error);
    res
      .status(500)
      .json({ message: "Failed to assign profiles", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace-users/:userId
//
// Removes a user from the workspace entirely.
// Deletes all their profile assignments first, then the membership row.
//
// Payload:
// {
//   "workspaceId": "uuid"
// }
//
// This does NOT delete the User record itself — the user still exists in
// the system, they just no longer have access to this workspace.
// ─────────────────────────────────────────────────────────────────────────────

export async function removeUserFromWorkspace(req: Request, res: Response) {
  const { userId } = req.params;
  const { workspaceId } = req.body;

  if (!workspaceId) throw new ApiError(400, "workspaceId is required");

  try {
    await prisma.$transaction(async (tx) => {
      const member = await tx.workspaceUser.findUnique({
        where: {
          userId_workspaceId: { userId: userId as string, workspaceId },
        },
        select: { userId: true },
      });
      if (!member)
        throw new ApiError(404, "User is not part of this workspace");

      await tx.userProfile.deleteMany({
        where: { userId: userId as string, workspaceId },
      });
      await tx.workspaceUser.delete({
        where: {
          userId_workspaceId: { userId: userId as string, workspaceId },
        },
      });
    });

    res.json({ message: "User removed from workspace successfully" });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    console.error("removeUserFromWorkspace failed:", error);
    res.status(500).json({
      message: "Failed to remove user from workspace",
      error: error.message,
    });
  }
}

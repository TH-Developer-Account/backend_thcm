import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { buildUserPermissions } from "../utils/userPermission";

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
        // Don't return password!
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

    console.log("========>", permissions);

    // New
    const perm = {
      isSuperAdmin: false,
      permissions: [
        {
          action: "read",
          scopeType: "WORKSPACE",
          appKey: null,
          moduleKey: null,
        },
        {
          action: "write",
          scopeType: "APP",
          appKey: "HR",
          moduleKey: null,
        },
      ],
    };

    res.status(200).json({
      user,
      workspace: {
        id: workspace.workspaceId,
        isSuperAdmin: workspace.isSuperAdmin,
      },
      permissions,
    });
  } catch (error) {
    next(error);
  }
};

export async function getByDEmployees(req: Request, res: Response) {
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
    console.error("SAP error:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to fetch SAP data" });
  }
}

export async function getC4CEmployees(req: Request, res: Response) {
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
    console.error("SAP error:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to fetch SAP data" });
  }
}

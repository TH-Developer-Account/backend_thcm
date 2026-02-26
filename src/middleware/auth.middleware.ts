// middleware/auth.ts
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { buildUserPermissions } from "../utils/userPermission";

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ApiError(401, "No token provided");
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      sub: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        is_active: true,
        workspaces: {
          select: {
            workspaceId: true,
            isSuperAdmin: true,
          },
        },
      },
    });

    if (!user || !user.is_active) {
      throw new ApiError(401, "User not authorized");
    }

    const workspace = user.workspaces[0];

    const permissions = await buildUserPermissions(
      user.id,
      workspace.workspaceId,
    );

    req.user = {
      id: user.id,
      email: user.email,
      workspaceId: workspace.workspaceId,
      isSuperAdmin: workspace.isSuperAdmin,
      apps: permissions,
    };

    next();
  } catch (error) {
    res.sendStatus(401);
  }
};

export function authorize(app: string, module: string, action: string) {
  return (req, res, next) => {
    if (req.user?.isSuperAdmin) return next();

    const perms = req.user?.apps?.[app]?.[module];

    if (!perms || !perms.includes(action)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
}

import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

export const requireSuperAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = req.user?.id;
  if (!userId) return next(new ApiError(401, "Unauthorized"));

  const membership = await prisma.workspaceUser.findFirst({
    where: { userId },
    select: { isSuperAdmin: true },
  });

  if (!membership?.isSuperAdmin) {
    return next(new ApiError(403, "Super admin access required"));
  }

  next();
};

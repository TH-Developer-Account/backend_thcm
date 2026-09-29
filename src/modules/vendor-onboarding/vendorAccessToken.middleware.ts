import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import { prisma } from "@shared/config/prisma";
import { validateAccessToken } from "@shared/services/accessToken.services";

// Public-route auth, deliberately separate from requireAuth/JWT —
// a vendor is not a User and has no workspace membership.
export const requireVendorAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.params.token || req.body?.token;
    if (!token) throw new ApiError(400, "Access token is required");

    const tokenRecord = await validateAccessToken(
      token as string,
      "VENDOR_ONBOARDING",
    );
    if (!tokenRecord) {
      throw new ApiError(401, "This link is invalid or has already been used");
    }

    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: tokenRecord.subjectId },
    });
    if (!onboarding) throw new ApiError(404, "Vendor onboarding not found");

    if (onboarding.status !== "AWAITING_VENDOR") {
      throw new ApiError(
        400,
        "This onboarding request is no longer awaiting vendor submission",
      );
    }

    req.vendorAccessToken = { id: tokenRecord.id, onboarding };
    next();
  } catch (error) {
    next(error);
  }
};

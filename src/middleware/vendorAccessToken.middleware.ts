import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";
import { validateVendorAccessToken } from "../services/vendorAccessToken.services";

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

    const tokenRecord = await validateVendorAccessToken(token as string);
    if (!tokenRecord) {
      throw new ApiError(401, "This link is invalid or has already been used");
    }

    if (tokenRecord.onboarding.status !== "AWAITING_VENDOR") {
      throw new ApiError(
        400,
        "This onboarding request is no longer awaiting vendor submission",
      );
    }

    req.vendorAccessToken = tokenRecord;
    next();
  } catch (error) {
    next(error);
  }
};

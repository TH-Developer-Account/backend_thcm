import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import { prisma } from "@shared/config/prisma";
import { validateAccessToken } from "@shared/services/accessToken.services";

export const requireMedicalClaimAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.params.token || req.body?.token;
    if (!token) throw new ApiError(400, "Access token is required");

    const tokenRecord = await validateAccessToken(
      token as string,
      "MEDICAL_CLAIM",
    );
    if (!tokenRecord) {
      throw new ApiError(401, "This link is invalid or has already been used");
    }

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: tokenRecord.subjectId },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");

    if (claim.status !== "AWAITING_EX_EMPLOYEE") {
      throw new ApiError(
        400,
        "This link has already been used. Please log in with your credentials instead.",
      );
    }

    req.medicalClaimAccessToken = { id: tokenRecord.id, claim };
    next();
  } catch (error) {
    next(error);
  }
};

import { NextFunction, Request, Response } from "express";
import { approveStage } from "../services/workflow.service"; // adjust path
import { Prisma } from "../prisma/generated/prisma/client"; // for error handling
import ApiError from "../utils/apiError";

export const approveStageController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { stageId } = req.params;
    const userId = req.user?.id;
    if (!stageId) {
      throw new ApiError(400, "stageId is required");
    }

    if (!userId) {
      throw new ApiError(400, "Unauthorized");
    }

    await approveStage({
      stageId: stageId as string,
      userId: userId as string,
    });

    res.status(200).json({
      message: "Stage approval processed successfully",
    });
  } catch (error: any) {
    // Prisma-specific handling
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        throw new ApiError(404, "Approval record or stage not found");
      } else {
        next(error);
      }
    }
  }
};

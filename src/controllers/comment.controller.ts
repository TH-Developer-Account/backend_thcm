import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

export const addComment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;

    console.log("Adding comment - User ID:", userId);
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { approvalId, message, type = "COMMENT" } = req.body;

    if (!approvalId || !message) {
      throw new ApiError(400, "approvalId and message are required");
    }

    if (message.trim().length < 3) {
      throw new ApiError(400, "Comment too short");
    }

    // 1️⃣ Fetch approval with full context
    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      include: {
        stage: {
          include: {
            workflow: true,
          },
        },
      },
    });

    if (!approval) {
      throw new ApiError(404, "Approval not found");
    }

    const stage = approval.stage;
    const workflow = stage.workflow;

    // 2️⃣ Check if user is the assigned approver
    if (approval.approverId !== userId) {
      throw new ApiError(403, "You are not assigned to this approval");
    }

    // 3️⃣ Check if this is the CURRENT stage
    if (workflow.currentStage !== stage.stageOrder) {
      throw new ApiError(400, "This stage is not active");
    }

    // 4️⃣ Check stage status
    if (stage.status !== "IN_PROGRESS") {
      throw new ApiError(400, "Stage is not in progress");
    }

    // 5️⃣ Check approval status
    if (approval.status !== "PENDING") {
      throw new ApiError(400, "You have already acted on this approval");
    }

    // ✅ 6️⃣ Create comment
    const comment = await prisma.comment.create({
      data: {
        message,
        type,
        userId,
        approvalId,
      },
      include: {
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: "Comment added successfully",
      data: comment,
    });
  } catch (error) {
    next(error);
  }
};

export const getWorkflowComments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const workflowInstanceId = String(req.params.workflowInstanceId);

    if (!workflowInstanceId) {
      throw new ApiError(400, "workflowInstanceId is required");
    }

    // 1️⃣ Validate workflow exists
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowInstanceId },
      select: { id: true },
    });

    if (!workflow) {
      throw new ApiError(404, "Workflow instance not found");
    }

    // 2️⃣ Fetch all comments across stages & approvals
    const comments = await prisma.comment.findMany({
      where: {
        approval: {
          stage: {
            workflow: {
              id: workflowInstanceId,
            },
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
          },
        },
        approval: {
          select: {
            id: true,
            status: true,
            approverId: true,
            stage: {
              select: {
                id: true,
                stageOrder: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: "asc", // timeline order
      },
    });

    res.status(200).json({
      success: true,
      count: comments.length,
      data: comments,
    });
  } catch (error) {
    next(error);
  }
};

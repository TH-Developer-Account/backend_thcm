import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { approveStage } from "../services/workflow.service"; // adjust path
import { Prisma } from "../prisma/generated/prisma/client"; // for error handling
import { budgetMap } from "../utils/contants";
import ApiError from "../utils/apiError";

const evaluateBudget = (
  selectedValue: string,
  actualValue: number,
): boolean => {
  const range = budgetMap[selectedValue];

  if (!range) return false;

  const { min, max } = range;

  if (max === null) {
    return actualValue >= min;
  }

  return actualValue >= min && actualValue <= max;
};

export const assignWorkflowController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    const { eventProposalId, workspaceId, appId, budget } = req.body;

    if (!userId) {
      throw new ApiError(401, "Unauthorized");
    }

    // 1️⃣ Get all templates for this app + workspace
    const templates = await prisma.workflowTemplate.findMany({
      where: {
        workspaceId,
        appId,
        workFlowUsers: {
          some: {
            userId,
          },
        },
      },
      include: {
        stages: {
          include: {
            approvers: true,
          },
        },
      },
    });

    if (!templates.length) {
      throw new Error("No workflow templates found");
    }

    // 2️⃣ Filter templates based on metaData_1 condition
    const matchedTemplate = templates.find((template) => {
      const result = evaluateBudget(template.metaData_1 || "", Number(budget));
      return result;
    });

    if (!matchedTemplate) {
      throw new Error("No matching workflow template for given condition");
    }

    // 3️⃣ Create workflow instance
    const workflowInstance = await prisma.workflowInstance.create({
      data: {
        templateId: matchedTemplate.id,
        workspaceId,
        eventProposalId,
        currentStage: 1,

        stages: {
          create: matchedTemplate.stages.map((stage) => ({
            stageOrder: stage.stageOrder,
            strategy: stage.strategy,
            minApprovals: stage.minApprovals,
            status: stage.stageOrder === 1 ? "IN_PROGRESS" : "PENDING",

            approvals: {
              create: stage.approvers.map((a) => ({
                approverId: a.userId,
                status: "PENDING",
              })),
            },
          })),
        },
      },

      include: {
        template: true, // optional
        stages: {
          include: {
            approvals: {
              include: {
                approver: true, // 👈 assuming relation exists
              },
            },
          },
        },
      },
    });

    res.status(201).json({
      message: "Workflow assigned successfully",
      data: workflowInstance,
    });
  } catch (error) {
    next(error);
  }
};

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

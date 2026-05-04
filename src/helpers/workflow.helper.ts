import { prisma } from "../config/prisma";
import { StageStatus, ApprovalStatus } from "../prisma/generated/prisma/client";

export const buildWorkflowStages = (templateStages: any[]) => {
  return templateStages.map((stage: any) => ({
    name: stage.name,
    stageOrder: stage.stageOrder,
    strategy: stage.strategy,
    minApprovals: stage.minApprovals,
    stageName: stage.name,
    status:
      stage.stageOrder === 1 ? StageStatus.IN_PROGRESS : StageStatus.PENDING,

    approvals: {
      create: stage.approvers.map((a: any) => ({
        approverId: a.userId,
        status: ApprovalStatus.PENDING,
      })),
    },
  }));
};

export const approveStage = async ({
  stageId,
  userId,
}: {
  stageId: string;
  userId: string;
}) => {
  return prisma.$transaction(async (tx) => {
    // 1. Mark approval
    await tx.approval.update({
      where: {
        stageId_approverId: {
          stageId,
          approverId: userId,
        },
      },
      data: {
        status: "APPROVED",
        actedAt: new Date(),
      },
    });

    const stage = await tx.stageInstance.findUnique({
      where: { id: stageId },
      include: { approvals: true, workflow: true },
    });

    const approvedCount = stage!.approvals.filter(
      (a) => a.status === "APPROVED",
    ).length;

    const total = stage!.approvals.length;

    let isStageApproved = false;

    switch (stage!.strategy) {
      case "ALL":
        isStageApproved = approvedCount === total;
        break;
      case "ANY":
        isStageApproved = approvedCount >= 1;
        break;
      case "SOME":
        isStageApproved = approvedCount >= (stage!.minApprovals || 1);
        break;
    }

    if (!isStageApproved) return;

    // 2. Approve stage
    await tx.stageInstance.update({
      where: { id: stageId },
      data: { status: "APPROVED" },
    });

    // 3. Move to next stage
    const nextStage = await tx.stageInstance.findFirst({
      where: {
        workflowId: stage!.workflowId,
        stageOrder: stage!.stageOrder + 1,
      },
    });

    if (nextStage) {
      await tx.stageInstance.update({
        where: { id: nextStage.id },
        data: { status: "IN_PROGRESS" },
      });

      await tx.workflowInstance.update({
        where: { id: stage!.workflowId },
        data: { currentStage: nextStage.stageOrder },
      });
    } else {
      // final stage
      await tx.workflowInstance.update({
        where: { id: stage!.workflowId },
        data: { status: "APPROVED" },
      });
    }
  });
};

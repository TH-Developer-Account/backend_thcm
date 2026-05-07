import { prisma } from "../config/prisma";
import { selectTemplate } from "./template.service";
import { buildWorkflowStages } from "../helpers/workflow.helper";
import {
  ApprovalStatus,
  StageStatus,
  StrategyType,
  WorkflowStatus,
} from "../prisma/generated/prisma/client";
import ApiError from "../utils/apiError";

export const createEventProposalWithWorkflow = async (input: any) => {
  return prisma.$transaction(async (tx) => {
    // 1. Create EPC
    const epc = await tx.eventProposal.create({
      data: input,
    });

    // 2. Select template
    const template = await selectTemplate({
      workspaceId: input.workspaceId,
    });

    // 3. Build stages
    const stages = buildWorkflowStages(template.stages);

    // 4. Create workflow instance
    const workflow = await tx.workflowInstance.create({
      data: {
        templateId: template.id,
        workspaceId: input.workspaceId,
        eventProposalId: epc.id,
        currentStage: 1,

        stages: {
          create: stages,
        },
      },
      include: {
        stages: true,
      },
    });

    return { epc, workflow };
  });
};

export const approveStage = async ({
  stageId,
  userId,
}: {
  stageId: string;
  userId: string;
}) => {
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Mark approval
      await tx.approval.update({
        where: {
          stageId_approverId: {
            stageId,
            approverId: userId,
          },
        },
        data: {
          status: ApprovalStatus.APPROVED,
          actedAt: new Date(),
        },
      });

      const stage = await tx.stageInstance.findUnique({
        where: { id: stageId },
        include: { approvals: true, workflow: true },
      });

      const approvedCount = stage!.approvals.filter(
        (a) => a.status === ApprovalStatus.APPROVED,
      ).length;

      const total = stage!.approvals.length;

      let isStageApproved = false;

      switch (stage!.strategy) {
        case StrategyType.ALL:
          isStageApproved = approvedCount === total;
          break;
        case StrategyType.ANY:
          isStageApproved = approvedCount >= 1;
          break;
        case StrategyType.SOME:
          isStageApproved = approvedCount >= (stage!.minApprovals || 1);
          break;
      }

      if (!isStageApproved) return;

      // 2. Approve stage
      await tx.stageInstance.update({
        where: { id: stageId },
        data: { status: StageStatus.APPROVED },
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
          data: { status: StageStatus.IN_PROGRESS },
        });

        await tx.workflowInstance.update({
          where: { id: stage!.workflowId },
          data: { currentStage: nextStage.stageOrder },
        });
      } else {
        // final stage
        await tx.workflowInstance.update({
          where: { id: stage!.workflowId },
          data: { status: WorkflowStatus.APPROVED },
        });
      }

      await tx.approvalAudit.create({
        data: {
          workflowId: stage!.workflowId,
          stageId: stageId as string,
          approverId: userId,
          action: "APPROVED",
          reason: "This is approved",
        },
      });
    });
  } catch (error) {
    throw error;
  }
};

export const rejectStage = async ({
  stageId,
  userId,
  reason,
}: {
  stageId: string;
  userId: string;
  reason?: string;
}) => {
  return prisma.$transaction(async (tx) => {
    // 1. mark rejection
    await tx.approval.update({
      where: {
        stageId_approverId: {
          stageId,
          approverId: userId,
        },
      },
      data: {
        status: "REJECTED",
        reason,
        actedAt: new Date(),
      },
    });

    const stage = await tx.stageInstance.findUnique({
      where: { id: stageId },
      include: { workflow: true },
    });

    // 2. mark stage rejected
    await tx.stageInstance.update({
      where: { id: stageId },
      data: { status: "REJECTED" },
    });

    // 3. mark workflow rejected
    await tx.workflowInstance.update({
      where: { id: stage!.workflowId },
      data: { status: "REJECTED" },
    });

    // (optional) update EPC status
    await tx.eventProposal.update({
      where: { id: stage!.workflow.eventProposalId },
      data: { status: "REJECTED" },
    });
  });
};

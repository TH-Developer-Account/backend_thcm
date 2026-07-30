import { prisma } from "@shared/config/prisma";
import {
  StageStatus,
  ApprovalStatus,
  Prisma,
} from "../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// forkTemplateForClarify
//
// Called when the proposer edits stages/approvers while resolving a Clarify.
// We never mutate the workflow's existing template in place — that template
// may be reused by other instances, and an in-place edit would silently
// change workflows that never asked for it.
//
// Instead: clone the template + its stages/approvers into a new one-off
// WorkflowTemplate (ownerType USER, isReusable false), apply the requested
// stage list onto the clone, and hand back its id/stages so the caller can
// repoint WorkflowInstance.templateId and read stages from the fork.
//
// `editedStages` is a FULL replacement list — same shape template
// create/update already accept — no partial-merge logic to maintain.
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

export const forkTemplateForClarify = async (
  tx: Tx,
  originalTemplate: {
    name: string;
    description: string;
    workspaceId: string;
    appId: string;
    metaData_1: string;
    metaData_2: string;
    metaData_3: string;
  },
  editedStages: Array<{
    stageOrder: number;
    strategy: "ALL" | "ANY" | "SOME";
    minApprovals?: number | null;
    approverIds: string[];
  }>,
  userId: string,
) => {
  return tx.workflowTemplate.create({
    data: {
      name: `${originalTemplate.name} (edited)`,
      description: originalTemplate.description,
      workspaceId: originalTemplate.workspaceId,
      appId: originalTemplate.appId,
      metaData_1: originalTemplate.metaData_1,
      metaData_2: originalTemplate.metaData_2,
      metaData_3: originalTemplate.metaData_3,
      ownerType: "USER",
      isReusable: false,
      created_by_id: userId,
      updated_by_id: userId,
      stages: {
        create: editedStages.map((stage) => ({
          name: `Stage ${stage.stageOrder}`,
          stageOrder: stage.stageOrder,
          strategy: stage.strategy,
          minApprovals: stage.minApprovals ?? null,
          approvers: {
            create: stage.approverIds.map((approverId) => ({
              userId: approverId,
            })),
          },
        })),
      },
    },
    include: {
      stages: { include: { approvers: true }, orderBy: { stageOrder: "asc" } },
    },
  });
};

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
        isExternalApprover: a.isExternalApprover,
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

import { prisma } from "../config/prisma";
import { selectTemplate } from "./template.service";
import { buildWorkflowStages } from "../helpers/workflow.helper";
import { notify } from "../services/notification.services";
import { updateSubjectStatus } from "../helpers/workflowSubject.helper";
import {
  ApprovalStatus,
  StageStatus,
  StrategyType,
  WorkflowStatus,
} from "../prisma/generated/prisma/client";

type ApproveStageResult =
  | {
      kind: "advanced";
      workflowId: string;
      epcId: string;
      appId: string;
      nextStageId: string;
      nextStageApproverIds: string[];
    }
  | { kind: "final_approved"; workflowId: string; epcId: string; appId: string }
  | { kind: "no_change" }; // stage strategy not yet satisfied — nothing to notify

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
        subjectType: "EVENT_PROPOSAL",
        subjectId: epc.id,
        currentStage: 1,
        appId: input.appId,

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
    const result: ApproveStageResult = await prisma.$transaction(async (tx) => {
      await tx.approval.update({
        where: { stageId_approverId: { stageId, approverId: userId } },
        data: { status: ApprovalStatus.APPROVED, actedAt: new Date() },
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

      if (!isStageApproved) return { kind: "no_change" };

      // 2. Approve stage — UNCHANGED
      await tx.stageInstance.update({
        where: { id: stageId },
        data: { status: StageStatus.APPROVED },
      });

      // 3. Move to next stage — UNCHANGED lookup, but now also fetch
      //    approvals so we know exactly who to notify once committed.
      const nextStage = await tx.stageInstance.findFirst({
        where: {
          workflowId: stage!.workflowId,
          stageOrder: stage!.stageOrder + 1,
          isCurrentIteration: true,
        },
        include: { approvals: true }, // ✅ NEW — need approverIds for notify()
      });

      let outcome: ApproveStageResult;

      if (nextStage) {
        await tx.stageInstance.update({
          where: { id: nextStage.id },
          data: { status: StageStatus.IN_PROGRESS },
        });

        await tx.workflowInstance.update({
          where: { id: stage!.workflowId },
          data: { currentStage: nextStage.stageOrder },
        });

        outcome = {
          kind: "advanced",
          workflowId: stage!.workflowId,
          epcId: stage!.workflow.subjectId,
          appId: stage!.workflow.appId,
          nextStageId: nextStage.id,
          nextStageApproverIds: nextStage.approvals.map((a) => a.approverId),
        };
      } else {
        // final stage — UNCHANGED
        await tx.workflowInstance.update({
          where: { id: stage!.workflowId },
          data: { status: WorkflowStatus.APPROVED },
        });

        await updateSubjectStatus(
          tx,
          stage!.workflow.subjectType,
          stage!.workflow.subjectId,
          "APPROVED",
        );

        outcome = {
          kind: "final_approved",
          workflowId: stage!.workflowId,
          epcId: stage!.workflow.subjectId,
          appId: stage!.workflow.appId,
        };
      }

      // UNCHANGED
      await tx.activityLog.create({
        data: {
          subjectType: stage!.workflow.subjectType,
          subjectId: stage!.workflow.subjectId,
          actorId: userId,
          action: "APPROVED",
          workflowId: stage!.workflowId,
          stageId: stageId as string,
          metadata: { reason: "This is approved" },
        },
      });

      return outcome;
    });

    // ── Notify — strictly after the transaction has committed ─────────────
    if (result.kind === "no_change") return;

    const app = await prisma.app.findUnique({
      where: { id: result.appId },
      select: { key: true },
    });
    const epc = await prisma.eventProposal.findUnique({
      where: { id: result.epcId },
      select: { proposal_number: true, created_by_id: true },
    });

    if (result.kind === "advanced") {
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id: result.workflowId },
        select: { workspaceId: true },
      });

      await Promise.all(
        result.nextStageApproverIds.map((approverId) =>
          notify({
            workspaceId: workflow!.workspaceId,
            recipientId: approverId,
            type: "APPROVAL_PENDING",
            title: "Approval required",
            body: epc
              ? `EPC ${epc.proposal_number} is waiting on your approval.`
              : "An EPC is waiting on your approval.",
            link: `/map/epc/${result.epcId}`,
            metadata: {
              appKey: app?.key ?? "GENERIC",
              epcId: result.epcId,
              workflowId: result.workflowId,
              stageId: result.nextStageId,
            },
          }),
        ),
      );
    }

    if (result.kind === "final_approved" && epc?.created_by_id) {
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id: result.workflowId },
        select: { workspaceId: true },
      });

      await notify({
        workspaceId: workflow!.workspaceId,
        recipientId: epc.created_by_id,
        type: "APPROVAL_DECISION",
        title: "Event proposal approved",
        body: epc.proposal_number
          ? `EPC ${epc.proposal_number} has been fully approved.`
          : "Your event proposal has been fully approved.",
        link: `/map/epc/${result.epcId}`,
        metadata: {
          appKey: app?.key ?? "GENERIC",
          epcId: result.epcId,
          workflowId: result.workflowId,
        },
      });
    }
  } catch (error) {
    throw error;
  }
};

// 3. Replace rejectStage() entirely with the version below.
//    Same pattern: capture what's needed inside the tx, notify after commit.

export const rejectStage = async ({
  stageId,
  userId,
  reason,
}: {
  stageId: string;
  userId: string;
  reason?: string;
}) => {
  const result = await prisma.$transaction(async (tx) => {
    // 1. mark rejection — UNCHANGED
    await tx.approval.update({
      where: { stageId_approverId: { stageId, approverId: userId } },
      data: { status: "REJECTED", reason, actedAt: new Date() },
    });

    const stage = await tx.stageInstance.findUnique({
      where: { id: stageId },
      include: { workflow: true },
    });

    // 2. mark stage rejected — UNCHANGED
    await tx.stageInstance.update({
      where: { id: stageId },
      data: { status: "REJECTED" },
    });

    // 3. mark workflow rejected — UNCHANGED
    await tx.workflowInstance.update({
      where: { id: stage!.workflowId },
      data: { status: "REJECTED" },
    });

    await updateSubjectStatus(
      tx,
      stage!.workflow.subjectType,
      stage!.workflow.subjectId,
      "REJECTED",
    );

    return {
      workflowId: stage!.workflowId,
      epcId: stage!.workflow.subjectId,
      appId: stage!.workflow.appId,
      workspaceId: stage!.workflow.workspaceId,
    };
  });

  // ── Notify the proposer — strictly after the transaction has committed ──
  const app = await prisma.app.findUnique({
    where: { id: result.appId },
    select: { key: true },
  });
  const epc = await prisma.eventProposal.findUnique({
    where: { id: result.epcId },
    select: { proposal_number: true, created_by_id: true },
  });

  if (epc?.created_by_id) {
    await notify({
      workspaceId: result.workspaceId,
      recipientId: epc.created_by_id,
      type: "APPROVAL_DECISION",
      title: "Event proposal rejected",
      body: epc.proposal_number
        ? `EPC ${epc.proposal_number} was rejected.${reason ? ` Reason: ${reason}` : ""}`
        : `Your event proposal was rejected.${reason ? ` Reason: ${reason}` : ""}`,
      link: `/map/epc/${result.epcId}`,
      metadata: {
        appKey: app?.key ?? "GENERIC",
        epcId: result.epcId,
        workflowId: result.workflowId,
      },
    });
  }

  return result;
};

import { prisma } from "../config/prisma";
import { selectTemplate } from "./template.service";
import { buildWorkflowStages } from "../helpers/workflow.helper";
import { notify } from "../services/notification.services";
import type { NotificationType } from "../services/notification.services";

import {
  updateSubjectStatus,
  getSubjectNotificationMeta,
  SubjectNotificationMeta,
} from "../helpers/workflowSubject.helper";
import {
  ApprovalStatus,
  StageStatus,
  StrategyType,
  WorkflowStatus,
  WorkflowSubjectType,
} from "../prisma/generated/prisma/client";

type ApproveStageResult =
  | {
      kind: "advanced";
      workflowId: string;
      subjectType: WorkflowSubjectType;
      subjectId: string;
      appId: string;
      nextStageId: string;
      nextStageApproverIds: string[];
    }
  | {
      kind: "final_approved";
      workflowId: string;
      subjectType: WorkflowSubjectType;
      subjectId: string;
      appId: string;
    }
  | { kind: "no_change" }; // stage strategy not yet satisfied — nothing to notify

// ─────────────────────────────────────────────────────────────────────────────
// notifyAboutWorkflowEvent
//
// Shared by approveStage's two notify sites and rejectStage's one — all three
// do the same thing: look up the app key, resolve subject metadata, and fire
// a notify() call shaped from that metadata. Extracted so a change to what a
// workflow notification looks like happens in one place, not three.
// ─────────────────────────────────────────────────────────────────────────────

const notifyAboutWorkflowEvent = ({
  workspaceId,
  recipientId,
  appKey,
  subjectType,
  subjectId,
  subjectMeta,
  type,
  title,
  body,
  extraMetadata = {},
}: {
  workspaceId: string;
  recipientId: string;
  appKey: string | undefined;
  subjectType: WorkflowSubjectType;
  subjectId: string;
  subjectMeta: SubjectNotificationMeta;
  type: NotificationType;
  title: string;
  body: string;
  extraMetadata?: Record<string, unknown>;
}) =>
  notify({
    workspaceId,
    recipientId,
    type,
    title,
    body,
    link: subjectMeta.link,
    metadata: {
      appKey: appKey ?? "GENERIC",
      subjectType,
      subjectId,
      ...extraMetadata,
    },
  });

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
          subjectType: stage!.workflow.subjectType as WorkflowSubjectType,
          subjectId: stage!.workflow.subjectId,
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
          subjectType: stage!.workflow.subjectType as WorkflowSubjectType,
          subjectId: stage!.workflow.subjectId,
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
    const subjectMeta = await getSubjectNotificationMeta(
      result.subjectType,
      result.subjectId,
    );
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: result.workflowId },
      select: { workspaceId: true },
    });

    if (result.kind === "advanced") {
      await Promise.all(
        result.nextStageApproverIds.map((approverId) =>
          notifyAboutWorkflowEvent({
            workspaceId: workflow!.workspaceId,
            recipientId: approverId,
            appKey: app?.key,
            subjectType: result.subjectType,
            subjectId: result.subjectId,
            subjectMeta,
            type: "APPROVAL_PENDING",
            title: "Approval required",
            body: `${subjectMeta.displayLabel} is waiting on your approval.`,
            extraMetadata: {
              workflowId: result.workflowId,
              stageId: result.nextStageId,
            },
          }),
        ),
      );
    }

    if (result.kind === "final_approved" && subjectMeta.ownerId) {
      await notifyAboutWorkflowEvent({
        workspaceId: workflow!.workspaceId,
        recipientId: subjectMeta.ownerId,
        appKey: app?.key,
        subjectType: result.subjectType,
        subjectId: result.subjectId,
        subjectMeta,
        type: "APPROVAL_DECISION",
        title: "Approved",
        body: `${subjectMeta.displayLabel} has been fully approved.`,
        extraMetadata: { workflowId: result.workflowId },
      });
    }
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
      subjectType: stage!.workflow.subjectType as WorkflowSubjectType,
      subjectId: stage!.workflow.subjectId,
      appId: stage!.workflow.appId,
      workspaceId: stage!.workflow.workspaceId,
    };
  });

  // ── Notify the subject owner — strictly after the transaction has committed ──
  const app = await prisma.app.findUnique({
    where: { id: result.appId },
    select: { key: true },
  });
  const subjectMeta = await getSubjectNotificationMeta(
    result.subjectType,
    result.subjectId,
  );

  if (subjectMeta.ownerId) {
    await notifyAboutWorkflowEvent({
      workspaceId: result.workspaceId,
      recipientId: subjectMeta.ownerId,
      appKey: app?.key,
      subjectType: result.subjectType,
      subjectId: result.subjectId,
      subjectMeta,
      type: "APPROVAL_DECISION",
      title: "Rejected",
      body: `${subjectMeta.displayLabel} was rejected.${reason ? ` Reason: ${reason}` : ""}`,
      extraMetadata: { workflowId: result.workflowId },
    });
  }

  return result;
};

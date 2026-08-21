import { prisma } from "@shared/config/prisma";
import { selectTemplate } from "./template.service";
import { buildWorkflowStages } from "./workflow.helper";
import { notify } from "@notifications/notification.services";
import ApiError from "@shared/utils/apiError";

import { updateSubjectStatus } from "./workflowSubject.helper";
import {
  getSubjectNotificationMeta,
  SubjectNotificationMeta,
} from "@notifications/notification.helper";
import {
  Prisma,
  ApprovalStatus,
  StageStatus,
  StrategyType,
  WorkflowStatus,
  WorkflowSubjectType,
  ActivityAction,
} from "../../prisma/generated/prisma/client";
import { templateMatchResolvers } from "./workflow.helper";

interface AssignWorkflowParams {
  subjectType: WorkflowSubjectType;
  subjectId: string;
  workspaceId: string;
  appId: string;
  userId: string; // whose managed templates to search — see open question above
  criteria?: Record<string, unknown>;
}

type ActivityActor =
  | { type: "user"; id: string }
  | { type: "guest"; id: string };

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
  type: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// notifyStageApprovers
//
// Notifies every approver on a given stage that it's now pending on them.
// Self-contained (resolves workspace/app/subject meta itself) so it can be
// called straight after any transaction that activates a stage — currently
// assignWorkflowController (stage 1 on first creation) and
// activateFirstStageController (stage 1 on resubmit). approveStage's own
// mid-workflow advance keeps its existing inline notify — not rewired here,
// see self-review note below.
// ─────────────────────────────────────────────────────────────────────────────

export const notifyStageApprovers = async ({
  workflowId,
  subjectType,
  subjectId,
  appId,
  stageId,
  approverIds,
}: {
  workflowId: string;
  subjectType: WorkflowSubjectType;
  subjectId: string;
  appId: string;
  stageId: string;
  approverIds: string[];
}) => {
  if (!approverIds.length) return;

  const [app, subjectMeta, workflow] = await Promise.all([
    prisma.app.findUnique({ where: { id: appId }, select: { key: true } }),
    getSubjectNotificationMeta(subjectType, subjectId),
    prisma.workflowInstance.findUnique({
      where: { id: workflowId },
      select: { workspaceId: true },
    }),
  ]);

  await Promise.all(
    approverIds.map((approverId) =>
      notifyAboutWorkflowEvent({
        workspaceId: workflow!.workspaceId,
        recipientId: approverId,
        appKey: app?.key,
        subjectType,
        subjectId,
        subjectMeta,
        type: "APPROVAL_PENDING",
        title: "Approval required",
        body: `${subjectMeta.displayLabel} is waiting on your approval.`,
        extraMetadata: { workflowId, stageId },
      }),
    ),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// notifyProposerOfClarify
//
// Notifies the subject's owner (the proposer) that an approver requested
// clarification. Fires GENERIC per your note that NotificationType may
// become a plain string soon — no new enum value added here.
// ─────────────────────────────────────────────────────────────────────────────

export const notifyProposerOfClarify = async ({
  workflowId,
  subjectType,
  subjectId,
  appId,
  ownerId,
  reason,
  requestedByName,
}: {
  workflowId: string;
  subjectType: WorkflowSubjectType;
  subjectId: string;
  appId: string;
  ownerId: string;
  reason: string;
  requestedByName: string;
}) => {
  const [app, subjectMeta, workflow] = await Promise.all([
    prisma.app.findUnique({ where: { id: appId }, select: { key: true } }),
    getSubjectNotificationMeta(subjectType, subjectId),
    prisma.workflowInstance.findUnique({
      where: { id: workflowId },
      select: { workspaceId: true },
    }),
  ]);

  await notifyAboutWorkflowEvent({
    workspaceId: workflow!.workspaceId,
    recipientId: ownerId,
    appKey: app?.key,
    subjectType,
    subjectId,
    subjectMeta,
    type: "GENERIC",
    title: "Clarification requested",
    body: `${requestedByName} requested clarification on ${subjectMeta.displayLabel}: ${reason}`,
    extraMetadata: { workflowId },
  });
};

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

export async function activateFirstStageForResubmit(
  tx: Prisma.TransactionClient,
  workflowId: string,
  actor: ActivityActor,
  resubmittedAction: ActivityAction,
  resubmittedStatus: string,
) {
  const workflow = await tx.workflowInstance.findUnique({
    where: { id: workflowId },
    include: {
      stages: {
        where: { isCurrentIteration: true },
        orderBy: { stageOrder: "asc" },
      },
    },
  });

  if (!workflow) throw new ApiError(404, "Workflow not found");
  if (!workflow.isActive) {
    throw new ApiError(
      400,
      "This workflow has been superseded and is no longer active",
    );
  }
  if (workflow.status !== "IN_PROGRESS") {
    throw new ApiError(
      400,
      `Workflow is not in progress (current status: ${workflow.status})`,
    );
  }

  const alreadyActive = workflow.stages.find((s) => s.status === "IN_PROGRESS");
  if (alreadyActive) {
    throw new ApiError(
      409,
      `Stage ${alreadyActive.stageOrder} is already IN_PROGRESS for this iteration`,
    );
  }

  const firstStage = workflow.stages.find((s) => s.stageOrder === 1);
  if (!firstStage) {
    throw new ApiError(
      404,
      "Stage 1 not found in the current iteration for this workflow",
    );
  }

  await tx.stageInstance.update({
    where: { id: firstStage.id },
    data: { status: "IN_PROGRESS", startedAt: new Date() },
  });

  await tx.workflowInstance.update({
    where: { id: workflow.id },
    data: { currentStage: 1 },
  });

  await updateSubjectStatus(
    tx,
    workflow.subjectType,
    workflow.subjectId,
    resubmittedStatus,
  );

  await tx.activityLog.create({
    data: {
      subjectType: workflow.subjectType,
      subjectId: workflow.subjectId,
      actorId: actor.type === "user" ? actor.id : null,
      actorGuestId: actor.type === "guest" ? actor.id : null,
      action: resubmittedAction,
      workflowId: workflow.id,
      stageId: firstStage.id,
      metadata: { reason: "Resubmitted after clarification." },
    },
  });

  return {
    firstStageInstanceId: firstStage.id,
    subjectType: workflow.subjectType,
    subjectId: workflow.subjectId,
    appId: workflow.appId,
  };
}

export async function assignWorkflow(
  tx: Prisma.TransactionClient,
  {
    subjectType,
    subjectId,
    workspaceId,
    appId,
    userId,
    criteria,
  }: AssignWorkflowParams,
) {
  const matchResolver = templateMatchResolvers[subjectType];
  if (!matchResolver) {
    throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
  }

  const existing = await tx.workflowInstance.findFirst({
    where: { subjectType, subjectId, isActive: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      "An active workflow already exists for this record.",
    );
  }

  const templates = await tx.workflowTemplate.findMany({
    where: {
      workspaceId,
      appId,
      isActive: true,
    },
    include: {
      stages: { include: { approvers: true }, orderBy: { stageOrder: "asc" } },
    },
  });

  if (!templates.length) {
    throw new ApiError(
      404,
      "No workflow templates found for this workspace/app",
    );
  }

  const matchedTemplate = matchResolver(templates, criteria);
  if (!matchedTemplate) {
    throw new ApiError(
      400,
      "No matching workflow template found for the given criteria",
    );
  }

  const workflowInstance = await tx.workflowInstance.create({
    data: {
      templateId: matchedTemplate.id,
      workspaceId,
      appId,
      subjectType,
      subjectId,
      currentStage: 1,
      iteration: 1,
      isActive: true,
      workflowType: "STANDARD",
      stages: {
        create: matchedTemplate.stages.map((stage) => ({
          stageOrder: stage.stageOrder,
          strategy: stage.strategy,
          minApprovals: stage.minApprovals,
          stageName: stage.name,
          iteration: 1,
          isCurrentIteration: true,
          status: stage.stageOrder === 1 ? "IN_PROGRESS" : "PENDING",
          startedAt: stage.stageOrder === 1 ? new Date() : null,
          approvals: {
            create: stage.approvers.map((a) => ({
              approverId: a.userId,
              status: "PENDING",
              isExternalApprover: a.isExternalApprover,
            })),
          },
        })),
      },
    },
    include: {
      stages: {
        where: { isCurrentIteration: true },
        orderBy: { stageOrder: "asc" },
        include: { approvals: { select: { id: true, approverId: true } } },
      },
    },
  });

  // Notification is deliberately NOT inside this function's transaction —
  // same convention as everywhere else in this app (notify calls happen
  // after commit, per your transaction-discipline principle). Caller is
  // responsible for calling notifyStageApprovers itself, post-commit.
  const stageOne = workflowInstance.stages.find((s) => s.stageOrder === 1);

  return {
    workflowInstance,
    stageOneApproverIds: stageOne?.approvals.map((a) => a.approverId) ?? [],
    stageOneId: stageOne?.id,
  };
}

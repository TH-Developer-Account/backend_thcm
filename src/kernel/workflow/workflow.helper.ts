import { prisma } from "@shared/config/prisma";
import {
  StageStatus,
  ApprovalStatus,
  Prisma,
  WorkflowSubjectType,
} from "../../prisma/generated/prisma/client";
import ApiError from "@shared/utils/apiError";
import { budgetMap } from "@shared/utils/contants";

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

export const evaluateBudget = (
  selectedValue: string,
  actualValue: number,
): boolean => {
  const range = budgetMap[selectedValue];
  if (!range) return false;
  const { min, max } = range;
  if (max === null) return actualValue >= min;
  return actualValue >= min && actualValue <= max;
};

// ─────────────────────────────────────────────────────────────────────────────
// evaluateZone  ✅ NEW
//
// A template's `metaData_2` holds the zone (region_code) it's scoped to for
// matching purposes — same lightweight, migration-free convention as
// `metaData_1` holding the budget-range key. A template with no zone set
// (metaData_2 empty — every non-MAP template today) never matches a
// zone-scoped lookup; it's only reachable when the caller doesn't pass a
// zone at all (see templateMatchResolvers.EVENT_PROPOSAL below), which is
// what keeps this fully backward-compatible for apps that don't use zones.
// ─────────────────────────────────────────────────────────────────────────────

export const evaluateZone = (
  templateZone: string,
  selectedZone: string,
): boolean => {
  if (!templateZone) return false;
  return templateZone === selectedZone;
};

// ─────────────────────────────────────────────────────────────────────────────
// templateMatchResolvers
//
// assignWorkflowController used to hardcode budget-based matching, but budget
// only means something for EVENT_PROPOSAL. This is the single place that
// knows how each subject type picks a template out of the candidate list —
// same strategy-map shape as workflowSubject.helper.ts, so adding a new app's
// matching rule means adding one entry here, not touching the controller.
//
// EVENT_PROPOSAL    → zone first (when supplied), then budget range match
//                      against template.metaData_1. See the zone-matching
//                      note below.
// VENDOR_ONBOARDING → STUB: first active template, no criteria yet
// ─────────────────────────────────────────────────────────────────────────────

type CandidateTemplate = Prisma.WorkflowTemplateGetPayload<{
  include: {
    stages: { include: { approvers: true } };
  };
}>;

export const templateMatchResolvers: Record<
  WorkflowSubjectType,
  (
    templates: CandidateTemplate[],
    criteria: Record<string, unknown> | undefined,
  ) => CandidateTemplate | undefined
> = {
  // ✅ CHANGED — zone-first-then-budget, for the Marketing Activity Planner.
  //
  // `criteria.zone` is the EPC's selected zone (its region_code — see
  // common.app.helper's `useUserInfo`/the Zone master for the id↔code
  // mapping). When it's supplied, the candidate list is narrowed to
  // templates whose own `metaData_2` matches that zone FIRST, and only the
  // zone-matching candidates are then checked against budget — a budget
  // match against a template scoped to a different zone must never win.
  //
  // When no zone is supplied (every caller outside MAP today — preview/
  // assign calls that don't pass `criteria.zone`, and any template with
  // `metaData_2` left blank), this resolves exactly as before: budget-only,
  // against every candidate. This is what keeps the change additive rather
  // than breaking: a workspace with no zone-scoped templates yet behaves
  // identically to pre-zone behavior.
  EVENT_PROPOSAL: (templates, criteria) => {
    const budget = criteria?.budget;
    if (budget === undefined) return undefined;

    const zone =
      typeof criteria?.zone === "string" && criteria.zone
        ? criteria.zone
        : undefined;

    const zoneCandidates = zone
      ? templates.filter((t) => evaluateZone(t.metaData_2 || "", zone))
      : templates;

    return zoneCandidates.find((t) =>
      evaluateBudget(t.metaData_1 || "", Number(budget)),
    );
  },

  // STUB — no matching criteria decided yet for Vendor Onboarding.
  // Replace with a real resolver once that's defined; until then this
  // just takes the first active template configured for the workspace/app.
  VENDOR_ONBOARDING: (templates, criteria) => {
    const { workflowId } = criteria || {};
    return templates.find((t) => t.id === workflowId);
  },

  MEDICAL_CLAIM: (templates) => {
    return templates.find(
      (t) => t.isActive === true && t.ownerType === "ADMIN",
    );
  },
};

export const forkTemplateForClarify = async (
  tx: Tx,
  baseTemplate: {
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
    approvers: Array<{ approverId: string; isExternalApprover?: boolean }>;
  }>,
  userId: string,
) => {
  return tx.workflowTemplate.create({
    data: {
      name: `${baseTemplate.name} (edited)`,
      description: baseTemplate.description,
      workspaceId: baseTemplate.workspaceId,
      appId: baseTemplate.appId,
      metaData_1: baseTemplate.metaData_1,
      metaData_2: baseTemplate.metaData_2,
      metaData_3: baseTemplate.metaData_3,
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
            create: stage.approvers.map((approver) => ({
              userId: approver.approverId,
              isExternalApprover: approver.isExternalApprover ?? false,
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

// ─────────────────────────────────────────────────────────────────────────────
// createIterationStages
//
// Materializes StageInstance + Approval rows for one iteration of a
// WorkflowInstance, from a resolved template's stages. Single place for this
// so callers (activate-stage: no-edit resubmit, edited-stage resubmit,
// template-swap resubmit) never hand-roll the same create loop three times.
//
// `activateFirst: true` flips stage 1 straight to IN_PROGRESS (the resubmit
// case). `activateFirst: false` leaves everything PENDING (the clarify-time
// draft case) — kept as a param rather than a second near-duplicate function.
// ─────────────────────────────────────────────────────────────────────────────

type TemplateStageInput = {
  name: string;
  stageOrder: number;
  strategy: "ALL" | "ANY" | "SOME";
  minApprovals?: number | null;
  approvers: Array<{ userId: string; isExternalApprover?: boolean }>;
};

export const createIterationStages = async (
  tx: Tx,
  params: {
    workflowId: string;
    iteration: number;
    templateStages: TemplateStageInput[];
    activateFirst: boolean;
  },
) => {
  const createdStages = [];
  let firstStageInstanceId: string | undefined;

  for (const templateStage of params.templateStages) {
    const isFirstStage = templateStage.stageOrder === 1;
    const shouldActivate = isFirstStage && params.activateFirst;

    const stage = await tx.stageInstance.create({
      data: {
        stageName: templateStage.name,
        workflowId: params.workflowId,
        stageOrder: templateStage.stageOrder,
        iteration: params.iteration,
        isCurrentIteration: true,
        strategy: templateStage.strategy,
        minApprovals: templateStage.minApprovals ?? null,
        status: shouldActivate ? "IN_PROGRESS" : "PENDING",
        startedAt: shouldActivate ? new Date() : null,
        approvals: {
          create: templateStage.approvers.map((a) => ({
            approverId: a.userId,
            status: "PENDING",
            isExternalApprover: a.isExternalApprover ?? false,
          })),
        },
      },
      include: { approvals: true },
    });

    createdStages.push(stage);
    if (isFirstStage) firstStageInstanceId = stage.id;
  }

  return { createdStages, firstStageInstanceId };
};

// ─────────────────────────────────────────────────────────────────────────────
// assertTemplateAssignable
//
// Same eligibility rule attachWorkflowController's Case A already enforces
// for "attach an existing reusable template" — pulled out here so
// activateFirstStageController's template-swap-on-resubmit path can reuse it
// instead of re-deriving the same checks.
// ─────────────────────────────────────────────────────────────────────────────

export const assertTemplateAssignable = async (
  tx: Tx,
  params: {
    templateId: string;
    appId: string;
    userId: string;
    isSuperAdmin: boolean;
  },
) => {
  const template = await tx.workflowTemplate.findUnique({
    where: { id: params.templateId },
    include: {
      stages: { include: { approvers: true }, orderBy: { stageOrder: "asc" } },
    },
  });

  if (!template) throw new ApiError(404, "Workflow template not found");
  // if (!template.isActive || !template.isReusable) {
  //   throw new ApiError(400, "This template is not available for use");
  // }
  if (!template.isActive) {
    throw new ApiError(400, "This template is not available for use");
  }
  if (template.appId !== params.appId) {
    throw new ApiError(
      400,
      "This template belongs to a different app than this record",
    );
  }

  if (!params.isSuperAdmin) {
    const isAssigned = await tx.workFlowTemplateUser.findUnique({
      where: {
        templateId_userId: {
          templateId: params.templateId,
          userId: params.userId,
        },
      },
    });
    if (!isAssigned) {
      throw new ApiError(403, "You are not assigned to this workflow template");
    }
  }

  return template;
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

// ─────────────────────────────────────────────────────────────────────────────
// reconcileLiveWorkflowInstances  ✅ NEW
//
// Requirement: editing a template with running (IN_PROGRESS) workflow
// instances must no longer be blocked outright — it should propagate onto
// every live instance, EXCEPT that an approval already cast must never be
// touched, and a stage can never be removed while instances are running
// (that guard lives in template.service.ts's updateTemplate, before this
// runs — by the time this is called, `stages` is already known to contain
// every stageOrder the live instances currently have).
//
// For each live instance (status IN_PROGRESS, this template), per stage:
//   - Stage doesn't exist yet on the instance (a brand-new stageOrder was
//     appended) → materialize it fresh, PENDING, with the template's
//     current approvers. Appending is the only stage-level change allowed
//     while instances are running (see the guard above), so a "new"
//     stageOrder here is always a genuine append, never a renumbered one —
//     that's what keeps approveStage's `stageOrder + 1` lookup safe: no
//     existing stageOrder ever shifts.
//   - Stage already APPROVED or REJECTED → history. Left untouched,
//     strategy/approvers included — the edit doesn't rewrite the past.
//   - Stage still PENDING or IN_PROGRESS → still open, so it's brought in
//     line with the edited template:
//       • strategy/minApprovals updated to the template's current values.
//       • approvers newly added to the stage get a fresh PENDING Approval.
//       • approvers dropped from the stage lose their approval slot, but
//         ONLY if it's still PENDING — an approver who already acted
//         (APPROVED/REJECTED/CLARIFY) keeps that record exactly as cast,
//         per "approvers that already approved should not be changed".
//
// Returns the set of { workflowId, stageId, newApproverIds, ... } entries
// for stages that are IN_PROGRESS right now and gained an approver — the
// caller notifies those approvers after the transaction commits (workflow
// notifications are always post-commit, never inside the transaction that
// creates them). A newly added approver on a stage that hasn't activated
// yet needs no notification here: they'll be notified the normal way, via
// notifyStageApprovers, whenever that stage actually activates.
// ─────────────────────────────────────────────────────────────────────────────

type ReconcileStageInput = {
  stageOrder: number;
  strategy: "ALL" | "ANY" | "SOME";
  minApprovals?: number | null;
  approverIds: string[];
};

export type ReconcileNotification = {
  workflowId: string;
  subjectType: WorkflowSubjectType;
  subjectId: string;
  appId: string;
  stageId: string;
  newApproverIds: string[];
};

export const reconcileLiveWorkflowInstances = async (
  tx: Tx,
  params: {
    templateId: string;
    stages: ReconcileStageInput[];
  },
): Promise<ReconcileNotification[]> => {
  const { templateId, stages } = params;

  const liveInstances = await tx.workflowInstance.findMany({
    where: { templateId, status: "IN_PROGRESS" },
    include: {
      stages: {
        where: { isCurrentIteration: true },
        include: { approvals: true },
      },
    },
  });

  if (!liveInstances.length) return [];

  const notifications: ReconcileNotification[] = [];

  for (const instance of liveInstances) {
    const liveStagesByOrder = new Map(
      instance.stages.map((stage) => [stage.stageOrder, stage]),
    );

    for (const templateStage of stages) {
      const liveStage = liveStagesByOrder.get(templateStage.stageOrder);

      // ── A new stage, appended at the end ────────────────────────────
      if (!liveStage) {
        await tx.stageInstance.create({
          data: {
            workflowId: instance.id,
            stageName: `Stage ${templateStage.stageOrder}`,
            stageOrder: templateStage.stageOrder,
            iteration: instance.iteration,
            isCurrentIteration: true,
            strategy: templateStage.strategy,
            minApprovals: templateStage.minApprovals ?? null,
            status: "PENDING",
            approvals: {
              create: templateStage.approverIds.map((approverId) => ({
                approverId,
                status: "PENDING",
              })),
            },
          },
        });
        continue;
      }

      // ── Already concluded — history, never rewritten ────────────────
      if (liveStage.status === "APPROVED" || liveStage.status === "REJECTED") {
        continue;
      }

      // ── Still open (PENDING or IN_PROGRESS) — bring it in line ──────
      await tx.stageInstance.update({
        where: { id: liveStage.id },
        data: {
          strategy: templateStage.strategy,
          minApprovals: templateStage.minApprovals ?? null,
        },
      });

      const existingApproverIds = new Set(
        liveStage.approvals.map((a) => a.approverId),
      );
      const nextApproverIds = new Set(templateStage.approverIds);

      const toAdd = templateStage.approverIds.filter(
        (approverId) => !existingApproverIds.has(approverId),
      );
      if (toAdd.length) {
        await tx.approval.createMany({
          data: toAdd.map((approverId) => ({
            stageId: liveStage.id,
            approverId,
            status: "PENDING",
          })),
        });

        // Only a stage that's already running needs an immediate nudge —
        // a PENDING stage's approvers are notified later, when it activates.
        if (liveStage.status === "IN_PROGRESS") {
          notifications.push({
            workflowId: instance.id,
            subjectType: instance.subjectType,
            subjectId: instance.subjectId,
            appId: instance.appId,
            stageId: liveStage.id,
            newApproverIds: toAdd,
          });
        }
      }

      // Dropped approvers lose only a still-PENDING slot — anything already
      // acted on (APPROVED/REJECTED/CLARIFY) is left exactly as cast.
      const toRemove = liveStage.approvals.filter(
        (a) => a.status === "PENDING" && !nextApproverIds.has(a.approverId),
      );
      if (toRemove.length) {
        await tx.approval.deleteMany({
          where: { id: { in: toRemove.map((a) => a.id) } },
        });
      }
    }
  }

  return notifications;
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

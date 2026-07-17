import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { approveStage } from "../services/workflow.service";
import { Prisma, WorkflowSubjectType } from "../prisma/generated/prisma/client";
import { budgetMap } from "../utils/contants";
import ApiError from "../utils/apiError";
import {
  updateSubjectStatus,
  getClarifyResetStatus,
} from "../helpers/workflowSubject.helper";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const evaluateBudget = (
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
// templateMatchResolvers  ✅ NEW
//
// assignWorkflowController used to hardcode budget-based matching, but budget
// only means something for EVENT_PROPOSAL. This is the single place that
// knows how each subject type picks a template out of the candidate list —
// same strategy-map shape as workflowSubject.helper.ts, so adding a new app's
// matching rule means adding one entry here, not touching the controller.
//
// EVENT_PROPOSAL    → budget range match against template.metaData_1
// VENDOR_ONBOARDING → STUB: first active template, no criteria yet
// ─────────────────────────────────────────────────────────────────────────────

type CandidateTemplate = Prisma.WorkflowTemplateGetPayload<{
  include: {
    stages: { include: { approvers: true } };
  };
}>;

const templateMatchResolvers: Record<
  WorkflowSubjectType,
  (
    templates: CandidateTemplate[],
    criteria: Record<string, unknown> | undefined,
  ) => CandidateTemplate | undefined
> = {
  EVENT_PROPOSAL: (templates, criteria) => {
    const budget = criteria?.budget;
    if (budget === undefined) return undefined;
    return templates.find((t) =>
      evaluateBudget(t.metaData_1 || "", Number(budget)),
    );
  },

  // STUB — no matching criteria decided yet for Vendor Onboarding.
  // Replace with a real resolver once that's defined; until then this
  // just takes the first active template configured for the workspace/app.
  VENDOR_ONBOARDING: (templates) => templates[0],
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/assign
//
// Creates a WorkflowInstance for any registered subject type. Template
// selection criteria is app-specific (see templateMatchResolvers above);
// everything else — duplicate-active-workflow guard, stage/approval seeding —
// is already generic and unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const assignWorkflowController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { subjectType, subjectId, workspaceId, appId, criteria } = req.body;

    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!subjectType || !subjectId || !workspaceId || !appId) {
      throw new ApiError(
        400,
        "subjectType, subjectId, workspaceId and appId are required",
      );
    }

    const matchResolver =
      templateMatchResolvers[subjectType as WorkflowSubjectType];
    if (!matchResolver) {
      throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
    }

    // Guard: reject if an active workflow already exists for this subject.
    // Only the Deviation controller is allowed to create a second workflow.
    const existing = await prisma.workflowInstance.findFirst({
      where: {
        subjectType,
        subjectId,
        isActive: true,
      },
    });
    if (existing) {
      throw new ApiError(
        409,
        "An active workflow already exists for this record. " +
          "Use the deviation endpoint to replace it.",
      );
    }

    // 1. Find all templates for this app + workspace that the user manages
    const templates = await prisma.workflowTemplate.findMany({
      where: {
        workspaceId,
        appId,
        isActive: true,
        workFlowUsers: { some: { userId } },
      },
      include: {
        stages: {
          include: { approvers: true },
          orderBy: { stageOrder: "asc" },
        },
      },
    });

    if (!templates.length) {
      throw new ApiError(
        404,
        "No workflow templates found for this workspace/app",
      );
    }

    // 2. Pick the template using the subject type's own matching rule
    const matchedTemplate = matchResolver(templates, criteria);
    if (!matchedTemplate) {
      throw new ApiError(
        400,
        "No matching workflow template found for the given criteria",
      );
    }

    // 3. Create the WorkflowInstance, StageInstances, and Approvals in one write
    const workflowInstance = await prisma.workflowInstance.create({
      data: {
        templateId: matchedTemplate.id,
        workspaceId,
        appId,
        subjectType,
        subjectId,
        currentStage: 1,
        iteration: 1, // ✅ NEW: first iteration
        isActive: true, // ✅ NEW: this is the active workflow
        workflowType: "STANDARD", // ✅ NEW: normal first-run

        stages: {
          create: matchedTemplate.stages.map((stage) => ({
            stageOrder: stage.stageOrder,
            strategy: stage.strategy,
            minApprovals: stage.minApprovals,
            stageName: stage.name,
            iteration: 1, // ✅ NEW: belongs to iteration 1
            isCurrentIteration: true, // ✅ NEW: these are the live stages
            // Stage 1 starts immediately; the rest are PENDING until their turn
            status: stage.stageOrder === 1 ? "IN_PROGRESS" : "PENDING",
            startedAt: stage.stageOrder === 1 ? new Date() : null, // ✅ NEW

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
        template: true,
        stages: {
          where: { isCurrentIteration: true }, // ✅ NEW: only return live stages
          orderBy: { stageOrder: "asc" },
          include: {
            approvals: {
              include: {
                approver: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: "Workflow assigned successfully",
      data: workflowInstance,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/preview
//
// Same template-matching logic as assignWorkflowController, minus the DB
// write — lets the frontend show "here's the workflow you'd get" before
// committing. Uses the same templateMatchResolvers strategy map, so any
// subject type wired up for assign automatically works here too.
// ─────────────────────────────────────────────────────────────────────────────

export const previewWorkflowController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { subjectType, workspaceId, appId, criteria } = req.body;

    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!subjectType || !workspaceId || !appId) {
      throw new ApiError(
        400,
        "subjectType, workspaceId and appId are required",
      );
    }

    const matchResolver =
      templateMatchResolvers[subjectType as WorkflowSubjectType];
    if (!matchResolver) {
      throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
    }

    // 1. Get templates
    const templates = await prisma.workflowTemplate.findMany({
      where: {
        workspaceId,
        appId,
        isActive: true,
        workFlowUsers: { some: { userId } },
      },
      include: {
        stages: {
          include: {
            approvers: {
              include: {
                user: true,
              },
            },
          },
          orderBy: { stageOrder: "asc" },
        },
      },
    });

    if (!templates.length) {
      throw new ApiError(404, "No workflow templates found");
    }

    // 2. Match template using the subject type's own matching rule
    const matchedTemplate = matchResolver(templates, criteria);

    if (!matchedTemplate) {
      throw new ApiError(
        400,
        "No matching workflow template found for the given criteria",
      );
    }

    // ✅ 3. RETURN TEMPLATE (NO DB WRITE)
    res.status(200).json({
      success: true,
      message: "Workflow preview fetched successfully",
      data: matchedTemplate,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/stages/:stageId/approve
//
// An approver approves their stage. Delegates to the approveStage service.
//
// NOTE FOR THE approveStage SERVICE:
//   When your service advances `currentStage` on the WorkflowInstance, make sure
//   it only counts StageInstances where `isCurrentIteration = true`. Otherwise
//   old iterations' stages will interfere with stage advancement logic.
//   Example fix inside the service:
//     const stages = await tx.stageInstance.findMany({
//       where: { workflowId, isCurrentIteration: true },
//       orderBy: { stageOrder: 'asc' }
//     });
// ─────────────────────────────────────────────────────────────────────────────

export const approveStageController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { stageId } = req.params;
    const userId = req.user?.id;

    if (!stageId) throw new ApiError(400, "stageId is required");
    if (!userId) throw new ApiError(401, "Unauthorized");

    // Validate the stage is current before handing off to the service
    const stage = await prisma.stageInstance.findUnique({
      where: { id: stageId as string },
      select: {
        isCurrentIteration: true,
        workflow: { select: { isActive: true } },
      },
    });

    if (!stage) throw new ApiError(404, "Stage not found");
    if (!stage.isCurrentIteration) {
      throw new ApiError(
        400,
        "This stage belongs to a past iteration and cannot be acted on",
      );
    }
    if (!stage.workflow.isActive) {
      throw new ApiError(
        400,
        "This workflow has been superseded and is no longer active",
      );
    }

    await approveStage({ stageId: stageId as string, userId });

    res.status(200).json({
      success: true,
      message: "Stage approval processed successfully",
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return next(new ApiError(404, "Approval record or stage not found"));
      }
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/stages/:stageId/clarify
//
// An approver requests clarification, restarting the entire workflow from
// stage 1 while preserving all historical data.
//
// Flow:
//   1. Validate the approver is assigned + stage is active + approval is PENDING
//   2. Mark the approval as CLARIFY
//   3. Flip isCurrentIteration=false on all current stages (keeps them for audit)
//   4. Create a fresh set of StageInstances + Approvals for iteration N+1
//   5. Increment WorkflowInstance.iteration and reset currentStage to 1
//   6. Write an ApprovalAudit record
//
// All steps run in a single transaction — either everything succeeds or nothing does.
// ─────────────────────────────────────────────────────────────────────────────

export const clarifyStageController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { stageId } = req.params;
    const userId = req?.user?.id;
    const { reason } = req.body;

    if (!stageId) throw new ApiError(400, "stageId is required");
    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!reason || String(reason).trim().length < 3) {
      throw new ApiError(
        400,
        "A reason of at least 3 characters is required for clarification",
      );
    }

    await prisma.$transaction(async (tx) => {
      // ── Step 1: Load stage with full context ──────────────────────────────
      const stage = await tx.stageInstance.findUnique({
        where: { id: stageId as string },
        include: {
          approvals: true,
          workflow: {
            include: {
              template: {
                include: {
                  stages: {
                    include: { approvers: true },
                    orderBy: { stageOrder: "asc" },
                  },
                },
              },
            },
          },
        },
      });

      if (!stage) throw new ApiError(404, "Stage not found");

      // ── Step 2: Guard checks ──────────────────────────────────────────────

      // Must be part of the live iteration
      if (!stage.isCurrentIteration) {
        throw new ApiError(400, "This stage belongs to a past iteration");
      }

      const workflow = stage.workflow;

      // Workflow must still be active (not superseded by a Deviation)
      if (!workflow.isActive) {
        throw new ApiError(
          400,
          "This workflow has been superseded and cannot be modified",
        );
      }

      // Stage must be the currently active stage
      if (workflow.currentStage !== stage.stageOrder) {
        throw new ApiError(400, "This stage is not currently active");
      }

      // Stage must be IN_PROGRESS
      if (stage.status !== "IN_PROGRESS") {
        throw new ApiError(400, "Stage is not in progress");
      }

      // User must have an approval record on this stage
      const approval = stage.approvals.find((a) => a.approverId === userId);
      if (!approval) {
        throw new ApiError(403, "You are not assigned to this stage");
      }

      // Approver must not have already acted
      if (approval.status !== "PENDING") {
        throw new ApiError(400, "You have already acted on this approval");
      }

      // ── Step 3: Mark this approval as CLARIFY ─────────────────────────────
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: "CLARIFY",
          reason: reason.trim(),
          actedAt: new Date(),
        },
      });

      // ── Step 4: Archive ALL current iteration stages ──────────────────────
      // Two calls because IN_PROGRESS needs status flipped to REJECTED (interrupted),
      // while PENDING + APPROVED keep their status — only isCurrentIteration clears.
      // Previously only PENDING was in the second filter, leaving APPROVED stages
      // with isCurrentIteration=true and causing doubled stages on the next iteration.
      await tx.stageInstance.updateMany({
        where: {
          workflowId: workflow.id,
          isCurrentIteration: true,
          status: "IN_PROGRESS",
        },
        data: { isCurrentIteration: false, status: "REJECTED" },
      });
      await tx.stageInstance.updateMany({
        where: {
          workflowId: workflow.id,
          isCurrentIteration: true,
          status: { in: ["PENDING", "APPROVED"] },
        },
        data: { isCurrentIteration: false },
      });

      // ── Step 5: Build new stages for iteration N+1 ────────────────────────
      const newIteration = workflow.iteration + 1;

      for (const templateStage of workflow.template.stages) {
        await tx.stageInstance.create({
          data: {
            stageName: templateStage.name,
            workflowId: workflow.id,
            stageOrder: templateStage.stageOrder,
            iteration: newIteration, // ← belongs to the new run
            isCurrentIteration: true, // ← these are now the live stages
            strategy: templateStage.strategy,
            minApprovals: templateStage.minApprovals,
            // Make all stages to pending
            status: "PENDING",
            startedAt: null,
            approvals: {
              create: templateStage.approvers.map((a) => ({
                approverId: a.userId,
                status: "PENDING",
              })),
            },
          },
        });
      }

      // ── Step 6: Advance the workflow's iteration counter ──────────────────
      await tx.workflowInstance.update({
        where: { id: workflow.id },
        data: {
          iteration: newIteration,
          currentStage: 1,
          // Status stays IN_PROGRESS — the workflow is still running
        },
      });

      // ── Step 7: Reset the subject's status (subject-type-agnostic) ────────
      // Was hardcoded to tx.eventProposal.update — now resolved via the
      // registry in workflowSubject.helper.ts. EPC resets to PENDING,
      // Vendor Onboarding resets to IN_REVIEW (back to the initiating
      // employee, not the vendor).
      await updateSubjectStatus(
        tx,
        workflow.subjectType,
        workflow.subjectId,
        getClarifyResetStatus(workflow.subjectType),
      );

      // ── Step 8: Write audit record ────────────────────────────────────────
      await tx.activityLog.create({
        data: {
          subjectType: workflow.subjectType,
          subjectId: workflow.subjectId,
          actorId: userId,
          action: "CLARIFY",
          workflowId: workflow.id,
          stageId: stageId as string,
          metadata: {
            reason: reason.trim(),
          },
        },
      });
    });

    res.status(200).json({
      success: true,
      message:
        "Clarification requested. Workflow has been restarted from stage 1. " +
        "Previous iteration data is preserved for audit.",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/activate-stage
//
// Activates stage 1 of the current iteration for a given workflow.
// This is used to formally "start" a workflow after it has been assigned —
// setting stage 1 to IN_PROGRESS so approvers can act on it.
//
// Body: { workflowId: string }
//
// Guards:
//   1. Workflow must exist and be active (not superseded)
//   2. Workflow must be IN_PROGRESS
//   3. There must be no IN_PROGRESS stage already in the current iteration
//      (prevents double-activation)
//   4. Stage with stageOrder=1 must exist in the current iteration
// ─────────────────────────────────────────────────────────────────────────────

export const activateFirstStageController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { workflowId } = req.body;

    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!workflowId) throw new ApiError(400, "workflowId is required");

    await prisma.$transaction(async (tx) => {
      // ── Step 1: Load the workflow ─────────────────────────────────────────
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

      // ── Guard 1: workflow must be active ──────────────────────────────────
      if (!workflow.isActive) {
        throw new ApiError(
          400,
          "This workflow has been superseded and is no longer active",
        );
      }

      // ── Guard 2: workflow must be IN_PROGRESS ─────────────────────────────
      if (workflow.status !== "IN_PROGRESS") {
        throw new ApiError(
          400,
          `Workflow is not in progress (current status: ${workflow.status})`,
        );
      }

      // ── Guard 3: no stage already IN_PROGRESS in the current iteration ────
      const alreadyActive = workflow.stages.find(
        (s) => s.status === "IN_PROGRESS",
      );
      if (alreadyActive) {
        throw new ApiError(
          409,
          `Stage ${alreadyActive.stageOrder} is already IN_PROGRESS for this iteration`,
        );
      }

      // ── Guard 4: stage 1 must exist in the current iteration ─────────────
      const firstStage = workflow.stages.find((s) => s.stageOrder === 1);
      if (!firstStage) {
        throw new ApiError(
          404,
          "Stage 1 not found in the current iteration for this workflow",
        );
      }

      // ── Activate stage 1 ──────────────────────────────────────────────────
      await tx.stageInstance.update({
        where: { id: firstStage.id },
        data: {
          status: "IN_PROGRESS",
          startedAt: new Date(),
        },
      });

      // ── Keep currentStage in sync on the workflow ─────────────────────────
      await tx.workflowInstance.update({
        where: { id: workflowId },
        data: { currentStage: 1 },
      });

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: workflow.subjectId,
          actorId: req.user?.id as string,
          action: "EPC_RESUBMITTED",
          workflowId: workflow.id,
          stageId: firstStage.id,
          metadata: {
            reason: "Proposer resubmitted the EPC.",
          },
        },
      });
    });

    res.status(200).json({
      success: true,
      message: "Stage 1 is now IN_PROGRESS",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflows/deviation
//
// Called when the budget of an EPC changes enough to require a different
// approval chain. Creates a brand-new WorkflowInstance (type=DEVIATION) for
// the same EPC and deactivates the previous one.
//
// Flow:
//   1. Validate there is an active IN_PROGRESS workflow for the EPC
//   2. Find a template matching the new budget
//   3. In a transaction:
//      a. Mark old workflow SUPERSEDED + isActive=false
//      b. Archive old workflow's current stages (isCurrentIteration=false)
//      c. Create new WorkflowInstance with workflowType=DEVIATION
//      d. Seed fresh StageInstances + Approvals from the matched template
//      e. Write an ApprovalAudit record for the deviation event
//
// Why a new WorkflowInstance instead of mutating the existing one?
//   - The old workflow's approvals and comments are untouched — full audit trail
//   - The two workflows can have different templates (different approval chains)
//   - isActive=true makes it trivial to query "the current workflow" for any EPC
// ─────────────────────────────────────────────────────────────────────────────

export const triggerDeviationController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { eventProposalId, workspaceId, appId, newBudget } = req.body;

    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!eventProposalId || !workspaceId || !appId || newBudget === undefined) {
      throw new ApiError(
        400,
        "eventProposalId, workspaceId, appId, and newBudget are required",
      );
    }

    // ── Step 1: Find the active workflow for this EPC ─────────────────────
    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: eventProposalId,
        isActive: true,
      },
    });

    if (!activeWorkflow) {
      throw new ApiError(
        404,
        "No active workflow found for this event proposal",
      );
    }
    if (activeWorkflow.status === "IN_PROGRESS") {
      throw new ApiError(
        400,
        "Deviation can only be triggered on an Approved workflow. " +
          `Current status: ${activeWorkflow.status}`,
      );
    }

    // ── Step 2: Find a template matching the new budget ───────────────────
    const templates = await prisma.workflowTemplate.findMany({
      where: {
        workspaceId,
        appId,
        isActive: true,
        workFlowUsers: { some: { userId } },
      },
      include: {
        stages: {
          include: { approvers: true },
          orderBy: { stageOrder: "asc" },
        },
      },
    });

    if (!templates.length) {
      throw new ApiError(
        404,
        "No workflow templates found for this workspace/app",
      );
    }

    const matchedTemplate = templates.find((t) =>
      evaluateBudget(t.metaData_1 || "", Number(newBudget)),
    );
    if (!matchedTemplate) {
      throw new ApiError(
        400,
        "No matching workflow template found for the new budget amount",
      );
    }

    // ── Step 3: Atomic swap — deactivate old, create new ─────────────────
    const newWorkflow = await prisma.$transaction(async (tx) => {
      // 3a. Deactivate the existing workflow
      await tx.workflowInstance.update({
        where: { id: activeWorkflow.id },
        data: {
          isActive: false,
          status: "SUPERSEDED", // ← new enum value; clearly not a normal rejection
        },
      });

      // 3b. Archive the current iteration's stages on the old workflow.
      //     Their approvals and comments remain fully intact for audit.
      await tx.stageInstance.updateMany({
        where: { workflowId: activeWorkflow.id, isCurrentIteration: true },
        data: { isCurrentIteration: false },
      });

      // 3c + 3d. Create the new deviation workflow with fresh stages
      const created = await tx.workflowInstance.create({
        data: {
          templateId: matchedTemplate.id,
          workspaceId,
          appId,
          subjectType: "EVENT_PROPOSAL",
          subjectId: eventProposalId,
          workflowType: "DEVIATION", // ← clearly marks this as a budget-change run
          isActive: true,
          iteration: 1, // ← deviation starts its own iteration counter at 1
          currentStage: 1,

          stages: {
            create: matchedTemplate.stages.map((stage) => ({
              stageName: stage.name,
              stageOrder: stage.stageOrder,
              strategy: stage.strategy,
              minApprovals: stage.minApprovals,
              iteration: 1,
              isCurrentIteration: true,
              status: stage.stageOrder === 1 ? "IN_PROGRESS" : "PENDING",
              startedAt: stage.stageOrder === 1 ? new Date() : null,
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
          template: { select: { id: true, name: true } },
          stages: {
            where: { isCurrentIteration: true },
            orderBy: { stageOrder: "asc" },
            include: {
              approvals: {
                include: {
                  approver: {
                    select: {
                      id: true,
                      first_name: true,
                      last_name: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // 3e. Audit record — uses AuditAction.DEVIATION
      //     stageId stores the superseded workflow's id as a reference point
      //     since there is no single "triggering stage" for a deviation.
      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: activeWorkflow.subjectId,
          actorId: userId,
          action: "EPC_RESUBMITTED",
          workflowId: activeWorkflow.id,
          stageId: null,
        },
      });

      return created;
    });

    res.status(201).json({
      success: true,
      message:
        "Deviation workflow created. The previous workflow has been superseded. " +
        "All its history (approvals, comments) is preserved.",
      data: {
        previousWorkflowId: activeWorkflow.id,
        newWorkflow,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflows/:workflowId
//
// Returns a WorkflowInstance with ONLY the current iteration's stages.
// Used for the "current state" view.
// ─────────────────────────────────────────────────────────────────────────────

export const getWorkflowController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { workflowId } = req.params;
    if (!workflowId) throw new ApiError(400, "workflowId is required");

    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowId as string },
      include: {
        template: { select: { id: true, name: true, description: true } },
        stages: {
          where: { isCurrentIteration: true }, // ← only live stages
          orderBy: { stageOrder: "asc" },
          include: {
            approvals: {
              include: {
                approver: {
                  select: { id: true, first_name: true, last_name: true },
                },
                comments: { orderBy: { createdAt: "asc" } },
              },
            },
          },
        },
      },
    });

    if (!workflow) throw new ApiError(404, "Workflow not found");

    res.status(200).json({ success: true, data: workflow });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflows/:workflowId/history
//
// Returns a WorkflowInstance with ALL stages across ALL iterations.
// Used for the full audit/history view.
// ─────────────────────────────────────────────────────────────────────────────

export const getWorkflowHistoryController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { workflowId } = req.params;
    if (!workflowId) throw new ApiError(400, "workflowId is required");

    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowId as string },
      include: {
        template: { select: { id: true, name: true, description: true } },
        stages: {
          // No isCurrentIteration filter — return everything
          orderBy: [
            { iteration: "asc" }, // group by iteration
            { stageOrder: "asc" }, // then by stage within each iteration
          ],
          include: {
            approvals: {
              include: {
                approver: {
                  select: { id: true, first_name: true, last_name: true },
                },
                comments: { orderBy: { createdAt: "asc" } },
              },
            },
          },
        },
      },
    });

    if (!workflow) throw new ApiError(404, "Workflow not found");

    // Group stages by iteration number for easier frontend consumption
    const iterationsMap = new Map<number, typeof workflow.stages>();
    for (const stage of workflow.stages) {
      const group = iterationsMap.get(stage.iteration) ?? [];
      group.push(stage);
      iterationsMap.set(stage.iteration, group);
    }

    const iterations = Array.from(iterationsMap.entries()).map(
      ([iteration, stages]) => ({ iteration, stages }),
    );

    res.status(200).json({
      success: true,
      data: {
        ...workflow,
        stages: undefined, // replaced by the grouped structure below
        iterations, // [ { iteration: 1, stages: [...] }, { iteration: 2, ... } ]
      },
    });
  } catch (error) {
    next(error);
  }
};

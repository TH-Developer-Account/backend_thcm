import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// POST /comments
//
// Adds a comment to an Approval.
//
// CHANGES from original:
//   1. Stage check now also verifies `stage.isCurrentIteration === true`
//      — prevents an approver from commenting on a stage that belongs to a
//        past clarify iteration (the record still exists in DB for audit but
//        should not accept new activity).
//   2. Workflow check now also verifies `workflow.isActive === true`
//      — prevents commenting on a workflow that has been SUPERSEDED by a
//        Deviation. The old workflow's data is read-only once superseded.
//
// The approval → stage → workflow chain guarantees full context:
// every comment knows exactly which iteration, which stage, and which
// workflow run it belongs to — without needing a direct EPC link.
// ─────────────────────────────────────────────────────────────────────────────

export const addComment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { approvalId, message, type = "COMMENT" } = req.body;

    if (!approvalId || !message) {
      throw new ApiError(400, "approvalId and message are required");
    }
    if (String(message).trim().length < 3) {
      throw new ApiError(400, "Comment must be at least 3 characters");
    }

    // ── Load approval with full context ──────────────────────────────────────
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

    if (!approval) throw new ApiError(404, "Approval not found");

    const stage = approval.stage;
    const workflow = stage.workflow;

    // ── Guard 1: must be the assigned approver ────────────────────────────────
    if (approval.approverId !== userId) {
      throw new ApiError(403, "You are not assigned to this approval");
    }

    // ── Guard 2: workflow must still be active ────────────────────────────────
    // ✅ NEW: once a Deviation supersedes a workflow, all its approvals become
    // read-only. An approver on the old workflow cannot add new comments.
    if (!workflow.isActive) {
      throw new ApiError(
        400,
        "This workflow has been superseded by a deviation and is now read-only",
      );
    }

    // ── Guard 3: stage must belong to the current iteration ───────────────────
    // ✅ NEW: after a CLARIFY the old stages remain in the DB but are no longer
    // active (isCurrentIteration=false). Block any action on them.
    if (!stage.isCurrentIteration) {
      throw new ApiError(
        400,
        "This stage belongs to a past clarification iteration and cannot receive new comments",
      );
    }

    // ── Guard 4: stage must be the currently active stage ─────────────────────
    if (workflow.currentStage !== stage.stageOrder) {
      throw new ApiError(400, "This stage is not currently active");
    }

    // ── Guard 5: stage must be IN_PROGRESS ───────────────────────────────────
    if (stage.status !== "IN_PROGRESS") {
      throw new ApiError(400, "Stage is not in progress");
    }

    // ── Guard 6: approver must not have already acted ────────────────────────
    if (approval.status !== "PENDING") {
      throw new ApiError(400, "You have already acted on this approval");
    }

    // ── Create the comment ───────────────────────────────────────────────────
    const comment = await prisma.comment.create({
      data: {
        message: String(message).trim(),
        type,
        userId,
        approvalId,
      },
      include: {
        user: {
          select: { id: true, first_name: true, last_name: true },
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

export const addCreatorComment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId, message, type = "COMMENT" } = req.body;

    if (!epcId) throw new ApiError(400, "epcId is required");
    if (!message) throw new ApiError(400, "message is required");
    if (String(message).trim().length < 3) {
      throw new ApiError(400, "Comment must be at least 3 characters");
    }

    // ── Load EPC with all workflow instances ─────────────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: {
        id: true,
        created_by_id: true,
        workflows: {
          select: { id: true, isActive: true },
          orderBy: { created_at: "desc" }, // most recent first
        },
      },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    // ── Guard: only the EPC creator can use this endpoint ────────────────────
    if (epc.created_by_id !== userId) {
      throw new ApiError(
        403,
        "Only the creator of this EPC can post a creator comment",
      );
    }

    // ── Guard: at least one workflow must exist ───────────────────────────────
    // A comment must anchor to a WorkflowInstance (for timeline context).
    // If no workflow has been assigned yet, there is nothing to attach to.
    if (!epc.workflows.length) {
      throw new ApiError(
        400,
        "No workflow has been assigned to this EPC yet. Comments can be added once a workflow is assigned.",
      );
    }

    // ── Pick the best workflowId to attach to ────────────────────────────────
    // Prefer the active workflow. Fall back to the most recently created one
    // (first in the desc-ordered list) if all workflows are superseded.
    const targetWorkflow =
      epc.workflows.find((w) => w.isActive) ?? epc.workflows[0];

    const comment = await prisma.comment.create({
      data: {
        message: String(message).trim(),
        type,
        userId,
        workflowId: targetWorkflow.id,
        approvalId: undefined,
      },
      include: {
        user: { select: { id: true, first_name: true, last_name: true } },
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /epc/:epcId/activity
//
// Unified chronological activity feed for an EPC covering its entire lifecycle.
// Merges three types of entries into one flat sorted array:
//
//   entryType: "COMMENT"        — approver comment (via approvalId chain)
//   entryType: "CREATOR_COMMENT"— creator comment (via workflowId directly)
//   entryType: "AUDIT_LOG"      — system event from ApprovalAudit
//                                 (APPROVED / REJECTED / CLARIFY / DEVIATION)
//
// DB round-trips: 4
//   1. eventProposal  → validate EPC, pull all workflowIds + metadata
//   2. comment        → approver comments via approval → stage → workflow chain
//   3. comment        → creator comments via workflowId directly
//   4. approvalAudit  → all audit rows with actor + stage included (via relations)
// ─────────────────────────────────────────────────────────────────────────────

export const getEPCActivityTimeline = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const epcId = String(req.params.epcId);
    if (!epcId) throw new ApiError(400, "epcId is required");

    // ── Step 1: Validate EPC + pull all workflow instance metadata ────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: {
        id: true,
        workflows: {
          select: { id: true, workflowType: true, isActive: true },
        },
      },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    if (!epc.workflows.length) {
      res.status(200).json({
        success: true,
        epcId,
        totalEntries: 0,
        data: [],
      });
    }

    const workflowIds = epc.workflows.map((w) => w.id);

    // O(1) annotation lookup: workflowId → { workflowType, isActive }
    const workflowMeta = new Map(
      epc.workflows.map((w) => [
        w.id,
        { workflowType: w.workflowType, isActive: w.isActive },
      ]),
    );

    // ── Step 2: Approver comments (approvalId is set, workflowId is null) ────
    const approverComments = await prisma.comment.findMany({
      where: {
        approvalId: { not: null },
        approval: {
          stage: { workflowId: { in: workflowIds } },
        },
      },
      select: {
        id: true,
        message: true,
        createdAt: true,
        user: { select: { id: true, first_name: true, last_name: true } },
        approval: {
          select: {
            stage: {
              select: {
                workflowId: true,
                stageOrder: true,
                stageName: true,
                iteration: true,
                isCurrentIteration: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // ── Step 3: Creator comments (workflowId is set, approvalId is null) ─────
    const creatorComments = await prisma.comment.findMany({
      where: {
        workflowId: { in: workflowIds },
        approvalId: null,
      },
      select: {
        id: true,
        message: true,
        createdAt: true,
        workflowId: true,
        user: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // ── Step 4: Audit logs (with actor + stage via Prisma relations) ──────────
    const auditLogs = await prisma.approvalAudit.findMany({
      where: { workflowId: { in: workflowIds } },
      select: {
        id: true,
        workflowId: true,
        action: true,
        reason: true,
        createdAt: true,
        actor: { select: { id: true, first_name: true, last_name: true } },
        stage: {
          select: {
            stageOrder: true,
            stageName: true,
            iteration: true,
            isCurrentIteration: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // ── Step 5: Shape and merge ───────────────────────────────────────────────

    type Actor = { id: string; first_name: string; last_name: string } | null;

    type StageContext = {
      stageOrder: number | null;
      stageName: string | null;
      iteration: number | null;
      isCurrentIteration: boolean | null;
    };

    type ApproverCommentEntry = {
      entryType: "COMMENT";
      id: string;
      message: string;
      actor: Actor;
      workflowId: string;
      workflowType: string | null;
      isActiveWorkflow: boolean | null;
      createdAt: string;
    } & StageContext;

    type CreatorCommentEntry = {
      entryType: "CREATOR_COMMENT";
      id: string;
      message: string;
      actor: Actor;
      workflowId: string;
      workflowType: string | null;
      isActiveWorkflow: boolean | null;
      // No stage context — creator comments are workflow-level, not stage-level
      stageOrder: null;
      stageName: null;
      iteration: null;
      isCurrentIteration: null;
      createdAt: string;
    };

    type AuditEntry = {
      entryType: "AUDIT_LOG";
      id: string;
      action: string;
      reason: string | null;
      actor: Actor;
      workflowId: string;
      workflowType: string | null;
      isActiveWorkflow: boolean | null;
      createdAt: string;
    } & StageContext;

    type TimelineEntry =
      | ApproverCommentEntry
      | CreatorCommentEntry
      | AuditEntry;

    const approverCommentEntries: ApproverCommentEntry[] = approverComments.map(
      (c) => {
        const wf = workflowMeta.get(c.approval!.stage.workflowId);
        return {
          entryType: "COMMENT",
          id: c.id,
          message: c.message,
          actor: c.user,
          workflowId: c.approval!.stage.workflowId,
          workflowType: wf?.workflowType ?? null,
          isActiveWorkflow: wf?.isActive ?? null,
          stageOrder: c.approval!.stage.stageOrder,
          stageName: c.approval!.stage.stageName,
          iteration: c.approval!.stage.iteration,
          isCurrentIteration: c.approval!.stage.isCurrentIteration,
          createdAt: c.createdAt.toISOString(),
        };
      },
    );

    const creatorCommentEntries: CreatorCommentEntry[] = creatorComments.map(
      (c) => {
        const wf = workflowMeta.get(c.workflowId!);
        return {
          entryType: "CREATOR_COMMENT",
          id: c.id,
          message: c.message,
          actor: c.user,
          workflowId: c.workflowId!,
          workflowType: wf?.workflowType ?? null,
          isActiveWorkflow: wf?.isActive ?? null,
          stageOrder: null,
          stageName: null,
          iteration: null,
          isCurrentIteration: null,
          createdAt: c.createdAt.toISOString(),
        };
      },
    );

    const auditEntries: AuditEntry[] = auditLogs.map((a) => {
      const wf = workflowMeta.get(a.workflowId);
      return {
        entryType: "AUDIT_LOG",
        id: a.id,
        action: a.action,
        reason: a.reason ?? null,
        actor: a.actor,
        workflowId: a.workflowId,
        workflowType: wf?.workflowType ?? null,
        isActiveWorkflow: wf?.isActive ?? null,
        stageOrder: a.stage?.stageOrder ?? null,
        stageName: a.stage?.stageName ?? null,
        iteration: a.stage?.iteration ?? null,
        isCurrentIteration: a.stage?.isCurrentIteration ?? null,
        createdAt: a.createdAt.toISOString(),
      };
    });

    const timeline: TimelineEntry[] = [
      ...approverCommentEntries,
      ...creatorCommentEntries,
      ...auditEntries,
    ].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    res.status(200).json({
      success: true,
      epcId,
      totalEntries: timeline.length,
      data: timeline,
    });
  } catch (error) {
    next(error);
  }
};

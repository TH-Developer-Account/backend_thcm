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

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflows/:workflowInstanceId/comments
//
// Returns all comments for a given workflow instance, ordered chronologically.
// Includes comments from ALL iterations (past clarify runs and the current one)
// so reviewers get the full conversation history in one call.
//
// The response includes stage context (stageOrder, iteration, isCurrentIteration)
// so the frontend can group comments by iteration and visually separate
// "this run" from "previous runs".
//
// CHANGE: added `isCurrentIteration` to the stage select so clients can
// distinguish current-iteration comments from historical ones without a
// second query.
// ─────────────────────────────────────────────────────────────────────────────

export const getWorkflowComments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const workflowInstanceId = String(req.params.workflowInstanceId);
    if (!workflowInstanceId) {
      throw new ApiError(400, "workflowInstanceId is required");
    }

    // Validate workflow exists
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowInstanceId },
      select: { id: true, iteration: true, isActive: true },
    });
    if (!workflow) throw new ApiError(404, "Workflow instance not found");

    // Fetch ALL comments across all stages and all iterations of this workflow.
    // No isCurrentIteration filter here — history view shows everything.
    const comments = await prisma.comment.findMany({
      where: {
        approval: {
          stage: {
            workflow: { id: workflowInstanceId },
          },
        },
      },
      include: {
        user: {
          select: { id: true, first_name: true, last_name: true },
        },
        approval: {
          select: {
            id: true,
            status: true,
            approverId: true,
            stage: {
              select: {
                id: true,
                stageOrder: true,
                iteration: true, // ✅ NEW: which clarify-run
                isCurrentIteration: true, // ✅ NEW: is this the live run?
                status: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" }, // chronological timeline
    });

    const formattedComments = comments.map((c) => ({
      id: c.id,
      comment: c.message,
      user: {
        id: c.user.id,
        first_name: c.user.first_name,
        last_name: c.user.last_name,
      },
      createdAt: c.createdAt.toISOString(), // optional but recommended
    }));

    res.status(200).json({
      success: true,
      workflowId: workflowInstanceId,
      totalComments: comments.length,
      data: formattedComments,
    });
  } catch (error) {
    next(error);
  }
};

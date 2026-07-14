import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import {
  getSubjectOwnerId,
  findSubjectById,
  getActiveWorkflowForSubject,
} from "../helpers/workflowSubject.helper";
import { addMailJob } from "../services/mail.service";
import { WorkflowSubjectType } from "../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// POST /comments
//
// Adds an approver's comment to an Approval. Already app-agnostic: an
// Approval's chain (approval → stage → workflow) carries its own
// subjectType/subjectId via the WorkflowInstance, so no subject lookup
// is needed here at all.
//
// NOTE: the previous version sent a mention-email and a notification here
// with a hardcoded app name / recipient / dashboard URL. That's app-specific
// wiring this generic controller shouldn't own, so it's removed pending a
// decision on how notify/mail should be parameterized per app.
// ─────────────────────────────────────────────────────────────────────────────
export const addComment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { approvalId, message, type = "COMMENT", to, cc } = req.body;

    if (!approvalId || !message) {
      throw new ApiError(400, "approvalId and message are required");
    }

    if (String(message).trim().length < 3) {
      throw new ApiError(400, "Comment must be at least 3 characters");
    }

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      include: {
        stage: { include: { workflow: true } },
        approver: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    if (!approval) throw new ApiError(404, "Approval not found");

    const stage = approval.stage;
    const workflow = stage.workflow;

    if (approval.approverId !== userId) {
      throw new ApiError(403, "You are not assigned to this approval");
    }

    if (!workflow.isActive) {
      throw new ApiError(
        400,
        "This workflow has been superseded by a deviation and is now read-only",
      );
    }

    if (!stage.isCurrentIteration) {
      throw new ApiError(
        400,
        "This stage belongs to a past clarification iteration and cannot receive new comments",
      );
    }

    if (workflow.currentStage !== stage.stageOrder) {
      throw new ApiError(400, "This stage is not currently active");
    }

    if (stage.status !== "IN_PROGRESS") {
      throw new ApiError(400, "Stage is not in progress");
    }

    if (approval.status !== "PENDING") {
      throw new ApiError(400, "You have already acted on this approval");
    }

    const comment = await prisma.comment.create({
      data: {
        message: String(message).trim(),
        type,
        userId,
        approvalId,
      },
      include: {
        user: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    if (to && Array.isArray(to) && to.length) {
      await addMailJob({
        to,
        cc: cc && Array.isArray(cc) && cc.length ? cc : undefined,
        subject: `Please check someone has mentioned you in a comment..!!`,
        templateName: "comment-mentioned",
        templateData: {
          appName: "Marketing Activity Planner",
          epcName: "test-epc",
          comment: message,
          approverName: `${approval.approver.first_name} ${approval.approver.last_name}`,
          dashboardUrl: `www.google.com`,
        },
      });
    }

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
// POST /comments/:subjectType/:subjectId/creator
//
// Adds a "creator" comment — one anchored directly to the active
// WorkflowInstance rather than to a specific Approval. Generic across any
// subjectType registered in workflowSubject.helper's resolver maps.
//
// getSubjectOwnerId does double duty here: it 404s if the subject doesn't
// exist, and returns the owning user id in the same round trip — no
// separate existence check needed before the ownership guard.
// ─────────────────────────────────────────────────────────────────────────────
export const addCreatorComment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const subjectType = req.params.subjectType as WorkflowSubjectType;
    const { subjectId } = req.params;
    const { message, type = "COMMENT" } = req.body;

    if (!message) throw new ApiError(400, "message is required");
    if (String(message).trim().length < 3) {
      throw new ApiError(400, "Comment must be at least 3 characters");
    }

    const ownerId = await getSubjectOwnerId(subjectType, subjectId as string);
    if (ownerId !== userId) {
      throw new ApiError(
        403,
        "Only the creator of this record can post a creator comment",
      );
    }

    const activeWorkflow = await getActiveWorkflowForSubject(
      subjectType,
      subjectId as string,
    );

    if (!activeWorkflow) {
      throw new ApiError(
        400,
        "No workflow has been assigned to this record yet. Comments can be added once a workflow is assigned.",
      );
    }

    const comment = await prisma.comment.create({
      data: {
        message: String(message).trim(),
        type,
        userId,
        workflowId: activeWorkflow.id,
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
// GET /comments/:subjectType/:subjectId/activity
//
// Unified chronological activity feed for any subject's lifecycle. Merges:
//   entryType: "COMMENT"         — approver comment (via approvalId chain)
//   entryType: "CREATOR_COMMENT" — creator comment (via workflowId directly)
//   entryType: "ACTIVITY_LOG"    — system event from ActivityLog
//
// DB round-trips: 4
//   1. findSubjectById   → validate subject exists (404s internally)
//   2. workflowInstance  → pull all workflowIds + metadata for this subject
//   3+4. comment (x2), activityLog → gather entries
// ─────────────────────────────────────────────────────────────────────────────
export const getActivityFeed = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const subjectType = req.params.subjectType as WorkflowSubjectType;
    const { subjectId } = req.params;

    await findSubjectById(subjectType, subjectId as string);

    const workflows = await prisma.workflowInstance.findMany({
      where: { subjectType, subjectId: subjectId as string },
      select: { id: true, workflowType: true, isActive: true },
    });

    if (!workflows.length) {
      res.status(200).json({
        success: true,
        subjectType,
        subjectId,
        totalEntries: 0,
        data: [],
      });
      return;
    }

    const workflowIds = workflows.map((w) => w.id);

    const workflowMeta = new Map(
      workflows.map((w) => [
        w.id,
        { workflowType: w.workflowType, isActive: w.isActive },
      ]),
    );

    const approverComments = await prisma.comment.findMany({
      where: {
        approvalId: { not: null },
        approval: { stage: { workflowId: { in: workflowIds } } },
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

    const activityLogs = await prisma.activityLog.findMany({
      where: { subjectType, subjectId: subjectId as string },
      select: {
        id: true,
        action: true,
        metadata: true,
        workflowId: true,
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
        workflow: { select: { workflowType: true, isActive: true } },
      },
      orderBy: { createdAt: "asc" },
    });

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
      stageOrder: null;
      stageName: null;
      iteration: null;
      isCurrentIteration: null;
      createdAt: string;
    };

    type ActivityLogEntry = {
      entryType: "ACTIVITY_LOG";
      id: string;
      action: string;
      metadata: unknown;
      actor: Actor;
      workflowId: string | null;
      workflowType: string | null;
      isActiveWorkflow: boolean | null;
      createdAt: string;
    } & StageContext;

    type TimelineEntry =
      | ApproverCommentEntry
      | CreatorCommentEntry
      | ActivityLogEntry;

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

    const activityLogEntries: ActivityLogEntry[] = activityLogs.map((a) => ({
      entryType: "ACTIVITY_LOG",
      id: a.id,
      action: a.action,
      metadata: a.metadata ?? null,
      actor: a.actor,
      workflowId: a.workflowId ?? null,
      workflowType: a.workflow?.workflowType ?? null,
      isActiveWorkflow: a.workflow?.isActive ?? null,
      stageOrder: a.stage?.stageOrder ?? null,
      stageName: a.stage?.stageName ?? null,
      iteration: a.stage?.iteration ?? null,
      isCurrentIteration: a.stage?.isCurrentIteration ?? null,
      createdAt: a.createdAt.toISOString(),
    }));

    const timeline: TimelineEntry[] = [
      ...approverCommentEntries,
      ...creatorCommentEntries,
      ...activityLogEntries,
    ].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    res.status(200).json({
      success: true,
      subjectType,
      subjectId,
      totalEntries: timeline.length,
      data: timeline,
    });
  } catch (error) {
    next(error);
  }
};

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
// GET /epc/:epcId/activity
//
// Single chat-like activity feed for an EPC covering its ENTIRE lifecycle:
// all workflow instances (STANDARD + every DEVIATION), all clarify iterations,
// all stages — merged into one flat chronological list.
//
// Every entry has a discriminated `entryType` field:
//
//   "COMMENT"   — free-text message left by an approver on their Approval
//   "AUDIT_LOG" — system event from ApprovalAudit:
//                   APPROVED  : approver approved their stage
//                   REJECTED  : approver rejected their stage
//                   CLARIFY   : approver sent workflow back to stage 1
//                   DEVIATION : budget changed, new workflow instance created
//
// ── How the query works now that ApprovalAudit has relations ─────────────────
// With proper FK relations on ApprovalAudit (workflow, stage?, actor), we can
// use a single `include` to get actor name and stage context inline — no manual
// batching or sentinel detection needed in application code.
//
// Total DB round-trips: 3
//   1. eventProposal  → validate EPC, pull all workflowIds + metadata
//   2. comment        → all comments with user + stage context
//   3. approvalAudit  → all audit rows with actor + stage included directly
//
// ── DEVIATION rows ───────────────────────────────────────────────────────────
// stageId is null for DEVIATION audit rows (no triggering stage). Prisma
// returns stage: null for those rows — no special handling needed.
//
// ── Response shape ───────────────────────────────────────────────────────────
// {
//   success: true,
//   epcId: "uuid",
//   totalEntries: 14,
//   data: [
//     {
//       entryType: "AUDIT_LOG",
//       id: "uuid",
//       action: "APPROVED",
//       reason: null,
//       actor: { id, first_name, last_name },
//       workflowId: "uuid",
//       workflowType: "STANDARD",
//       isActiveWorkflow: false,
//       stageOrder: 1,              // null for DEVIATION entries
//       stageName: "Finance Check", // null for DEVIATION entries
//       iteration: 1,              // null for DEVIATION entries
//       isCurrentIteration: false, // null for DEVIATION entries
//       createdAt: "ISO string"
//     },
//     {
//       entryType: "COMMENT",
//       id: "uuid",
//       message: "Please recheck budget line 3",
//       actor: { id, first_name, last_name },
//       workflowId: "uuid",
//       workflowType: "STANDARD",
//       isActiveWorkflow: true,
//       stageOrder: 1,
//       stageName: "Finance Check",
//       iteration: 2,
//       isCurrentIteration: true,
//       createdAt: "ISO string"
//     }
//   ]
// }
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
          select: {
            id: true,
            workflowType: true,
            isActive: true,
          },
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

    // Fast O(1) annotation lookup: workflowId → { workflowType, isActive }
    const workflowMeta = new Map(
      epc.workflows.map((w) => [
        w.id,
        { workflowType: w.workflowType, isActive: w.isActive },
      ]),
    );

    // ── Step 2: All comments across every workflow instance ───────────────────
    // Traverses Comment → Approval → StageInstance to get full stage context.
    const rawComments = await prisma.comment.findMany({
      where: {
        approval: {
          stage: { workflowId: { in: workflowIds } },
        },
      },
      select: {
        id: true,
        message: true,
        createdAt: true,
        user: {
          select: { id: true, first_name: true, last_name: true },
        },
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

    // ── Step 3: All audit rows — actor and stage included directly ────────────
    // ApprovalAudit now has proper @relation fields, so Prisma can traverse
    // actor (User) and stage (StageInstance?) inline. No manual batching needed.
    // stage is null for DEVIATION rows — Prisma returns null, no special casing.
    const rawAuditLogs = await prisma.approvalAudit.findMany({
      where: { workflowId: { in: workflowIds } },
      select: {
        id: true,
        workflowId: true,
        action: true,
        reason: true,
        createdAt: true,
        actor: {
          select: { id: true, first_name: true, last_name: true },
        },
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

    // ── Step 4: Shape and merge ───────────────────────────────────────────────

    const commentEntries = rawComments.map((c) => {
      const wf = workflowMeta.get(c.approval.stage.workflowId);
      return {
        entryType: "COMMENT",
        id: c.id,
        message: c.message,
        actor: c.user,
        workflowId: c.approval.stage.workflowId,
        workflowType: wf?.workflowType ?? null,
        isActiveWorkflow: wf?.isActive ?? null,
        stageOrder: c.approval.stage.stageOrder,
        stageName: c.approval.stage.stageName,
        iteration: c.approval.stage.iteration,
        isCurrentIteration: c.approval.stage.isCurrentIteration,
        createdAt: c.createdAt.toISOString(),
      };
    });

    const auditEntries = rawAuditLogs.map((a) => {
      const wf = workflowMeta.get(a.workflowId);
      return {
        entryType: "AUDIT_LOG",
        id: a.id,
        action: a.action,
        reason: a.reason ?? null,
        // actor relation is always populated (every audit row has an approverId)
        actor: a.actor,
        workflowId: a.workflowId,
        workflowType: wf?.workflowType ?? null,
        isActiveWorkflow: wf?.isActive ?? null,
        // stage is null for DEVIATION rows — Prisma returns null directly
        stageOrder: a.stage?.stageOrder ?? null,
        stageName: a.stage?.stageName ?? null,
        iteration: a.stage?.iteration ?? null,
        isCurrentIteration: a.stage?.isCurrentIteration ?? null,
        createdAt: a.createdAt.toISOString(),
      };
    });

    // Merge both arrays and sort by timestamp ascending (oldest first)
    const timeline = [...commentEntries, ...auditEntries].sort(
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

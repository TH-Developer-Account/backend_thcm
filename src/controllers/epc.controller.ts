// src/controllers/eventProposal.controller.ts
import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { epcFullInfoSelect } from "../utils/contants";
import { searchEventProposals } from "../helpers/searchEventProposal.helper";
import { createEventProposalWithWorkflow } from "../services/workflow.service";
import { getValidatorForApp } from "../utils/validators.constant";

// ─────────────────────────────────────────────────────────────────────────────
// Reusable select for the active workflow's current state.
// Used in getEventProposalById and anywhere you need EPC + live workflow data.
//
// Pattern:
//   workflows: { where: { isActive: true } }          ← only the active workflow
//   stages:    { where: { isCurrentIteration: true } } ← only the current run's stages
//
// For full history (all workflows, all iterations) use the history endpoint on
// the workflow controller instead — it keeps EPC queries lean.
// ─────────────────────────────────────────────────────────────────────────────

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const result = arr.filter((v): v is string => typeof v === "string");
  return result.length > 0 ? result : undefined;
}

const activeWorkflowInclude = {
  where: { isActive: true },
  include: {
    template: {
      select: { id: true, name: true, description: true },
    },
    stages: {
      where: { isCurrentIteration: true }, // ✅ only current iteration stages
      orderBy: { stageOrder: "asc" as const },
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
            comments: {
              orderBy: { createdAt: "asc" as const },
            },
          },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /epc/with-workflow
// Creates an EPC together with its initial workflow in a single service call.
// ─────────────────────────────────────────────────────────────────────────────

export const createEPCController = async (req: Request, res: Response) => {
  try {
    const result = await createEventProposalWithWorkflow(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /epc
// Creates an EPC without a workflow (workflow is assigned separately).
// ─────────────────────────────────────────────────────────────────────────────

export const createEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      proposal_number,
      event_name,
      event_from_date,
      event_to_date,
      event_description,
      location,
      locationMeta,
      event_objective,
      department,
      vertical,
      region,
      branch,
      budget_master_id,
    } = req.body;

    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    if (
      !proposal_number ||
      !event_name ||
      !event_from_date ||
      !event_to_date ||
      !department ||
      !region ||
      !branch ||
      !budget_master_id
    ) {
      throw new ApiError(400, "Missing required fields");
    }

    if (new Date(event_from_date) > new Date(event_to_date)) {
      throw new ApiError(400, "event_from_date cannot be after event_to_date");
    }

    const proposal = await prisma.eventProposal.create({
      data: {
        proposal_number,
        event_name_id: event_name,
        event_from_date: new Date(event_from_date),
        event_to_date: new Date(event_to_date),
        event_description,
        location,
        locationMeta,
        event_objective,
        department_id: department,
        vertical_id: vertical,
        region_id: region,
        branch_id: branch,
        event_scale: 0,
        budget_master_id,
        created_by_id: userId,
        updated_by_id: userId,
      },
    });

    await prisma.activityLog.create({
      data: {
        epcId: proposal.id,
        actorId: userId,
        action: "EPC_CREATED",
        workflowId: null,
        stageId: null,
        metadata: {
          reason: "EPC is Created.",
        },
      },
    });

    res.status(201).json({
      success: true,
      message: "EPC created successfully",
      data: proposal,
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      return next(new ApiError(409, "Proposal number already exists"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /epc
//
// Paginated list of EPCs with optional filters.
// Supports four main views:
//   ?pendingOnMe=true  — EPCs where the current user has a PENDING approval
//                        on the active workflow's current iteration
//   ?approvedByMe=true — EPCs where the current user has an APPROVED approval
//   (no flag)          — All EPCs, optionally filtered by status/dept/date
//
// NOTE: The `searchEventProposals` helper should be updated to use
//   `isActive: true` when filtering workflow instances, and
//   `isCurrentIteration: true` when filtering stages.
//   See the inline comment inside this function for the query shape.
// ─────────────────────────────────────────────────────────────────────────────

export const getAllEventProposals = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      page = "1",
      pageSize = "10",
      search,
      sortBy = "created_at",
      sortOrder = "desc",
      status,
      departmentId,
      approvedByMe,
      pendingOnMe,
      zone,
      eventType,
      eventDateFrom,
      eventDateTo,
      createdDate,
    } = req.query;

    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const pageNumber = Number(page);
    const take = Number(pageSize);

    // NOTE FOR searchEventProposals HELPER:
    // When building the `pendingOnMe` query, the where clause should be:
    //
    //   workflows: {
    //     some: {
    //       isActive: true,          ← active workflow only
    //       stages: {
    //         some: {
    //           isCurrentIteration: true,  ← current run only
    //           status: 'IN_PROGRESS',
    //           approvals: {
    //             some: {
    //               approverId: userId,
    //               status: 'PENDING'
    //             }
    //           }
    //         }
    //       }
    //     }
    //   }
    //
    // For `approvedByMe`:
    //   workflows: {
    //     some: {
    //       stages: {
    //         some: {
    //           approvals: {
    //             some: { approverId: userId, status: 'APPROVED' }
    //           }
    //         }
    //       }
    //     }
    //   }

    const { data, total } = await searchEventProposals({
      userId,
      approvedByMe: approvedByMe === "true",
      pendingOnMe: pendingOnMe === "true",
      pendingReportValidation:
        getValidatorForApp("MAP") === userId ? true : false,
      reportValidatedByMe: getValidatorForApp("MAP") === userId ? true : false,
      search: search as string,
      status: toStringArray(status),
      departmentId: departmentId ? String(departmentId) : undefined,
      startDate: eventDateFrom ? new Date(eventDateFrom as string) : undefined,
      endDate: eventDateTo ? new Date(eventDateTo as string) : undefined,
      page: pageNumber,
      pageSize: take,
      sortBy: sortBy as any,
      sortOrder: sortOrder === "asc" ? "asc" : "desc",
      zone: toStringArray(zone),
      eventType: toStringArray(eventType),
      createdDate: createdDate ? new Date(createdDate as string) : undefined,
    });

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: pageNumber,
        pageSize: take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /epc/:id
//
// Returns a single EPC with its ACTIVE workflow and CURRENT iteration stages.
// This is the standard "live state" view — fast and uncluttered.
//
// For full history (all workflows + all iterations), use:
//   GET /workflows/:workflowId/history
// ─────────────────────────────────────────────────────────────────────────────

export const getEventProposalById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    if (!id) throw new ApiError(400, "Invalid EPC ID");

    const epc = await prisma.eventProposal.findUnique({
      where: { id },
      include: {
        ...epcFullInfoSelect,

        // ✅ CHANGE: was `workflow: { ... }` (singular, optional)
        // Now `workflows` (plural) filtered to isActive=true.
        // Result is an array — take [0] if you need a single object,
        // or present it as-is to the client (max 1 element in normal operation).
        workflows: activeWorkflowInclude,
      },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    // Flatten for convenience: expose `activeWorkflow` directly rather than
    // making the client pick from the array.
    const { workflows, ...epcData } = epc;
    const response = {
      ...epcData,
      activeWorkflow: workflows[0] ?? null,
    };

    res.status(200).json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /epc/:id
//
// Updates an EPC's fields.
//
// ✅ BUG FIX: Original code had `if (id) throw` which threw on every valid
// request (a truthy id means the id IS present, not absent).
// Corrected to `if (!id)`.
// ─────────────────────────────────────────────────────────────────────────────

export const updateEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { ...data } = req.body;
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    // ✅ BUG FIX: was `if (id)` — inverted condition caused every request to fail
    if (!id) throw new ApiError(400, "Invalid ID");

    const updated = await prisma.eventProposal.update({
      where: { id },
      data: {
        ...data,
        updated_by_id: userId, // ✅ also fixed field name (was `updated_by`)
      },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Event Proposal not found"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /epc/:id  (soft delete — sets status to DELETED)
//
// ✅ BUG FIX: Same inverted `if (id)` issue as updateEventProposal.
// Also added a guard: an EPC with an active IN_PROGRESS workflow should not
// be deletable until the workflow is concluded or superseded.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    // ✅ BUG FIX: was `if (id)` — inverted condition caused every request to fail
    if (!id) throw new ApiError(400, "Invalid ID");

    // Guard: do not allow deletion while an active workflow is IN_PROGRESS
    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: { eventProposalId: id, isActive: true },
      select: { id: true, status: true },
    });

    if (activeWorkflow && activeWorkflow.status === "IN_PROGRESS") {
      throw new ApiError(
        409,
        "Cannot delete an EPC while its workflow is IN_PROGRESS. " +
          "Please complete or supersede the workflow first.",
      );
    }

    const updated = await prisma.eventProposal.update({
      where: { id },
      data: {
        status: "DELETED",
        updated_by_id: userId,
      },
    });

    res.status(200).json({
      success: true,
      message: "Event Proposal deleted successfully",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

const OUTCOME_STATUSES = new Set(["CONDUCTED", "CANCELLED"]);

export const updateEventProposalOutcome = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!id) throw new ApiError(400, "Invalid EPC ID");

    const { status, reason } = req.body as {
      status: string;
      reason?: string;
    };

    // ── Guard 1: valid target status ─────────────────────────────────────────
    if (!status || !OUTCOME_STATUSES.has(status)) {
      throw new ApiError(400, "status must be either CONDUCTED or CANCELLED");
    }

    // ── Load EPC — only the fields needed for guards ──────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        created_by_id: true,
      },
    });

    if (!epc) throw new ApiError(404, "Event Proposal not found");

    // ── Guard 2: only the original proposer can call this ─────────────────────
    if (epc.created_by_id !== userId) {
      throw new ApiError(
        403,
        "Only the original proposer can update the event outcome",
      );
    }

    // ── Guard 3: EPC must be in APPROVED state ────────────────────────────────
    if (epc.status !== "APPROVED") {
      throw new ApiError(
        400,
        `Event outcome can only be set on an APPROVED proposal. Current status: ${epc.status}`,
      );
    }

    // ── Guard 4: no active IN_PROGRESS workflow ───────────────────────────────
    // Workflow must be fully resolved before the proposer can record an outcome.
    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: { eventProposalId: id, isActive: true, status: "IN_PROGRESS" },
      select: { id: true },
    });

    if (activeWorkflow) {
      throw new ApiError(
        409,
        "Cannot update outcome while a workflow is still IN_PROGRESS. " +
          "The workflow must be fully resolved first.",
      );
    }

    // ── Determine the ActivityAction for the log ──────────────────────────────
    const activityAction =
      status === "CONDUCTED" ? "EPC_CONDUCTED" : "EPC_CANCELLED";

    // ── Atomic update + activity log ──────────────────────────────────────────
    const updated = await prisma.$transaction(async (tx) => {
      const proposal = await tx.eventProposal.update({
        where: { id },
        data: {
          status,
          updated_by_id: userId,
        },
      });

      await tx.activityLog.create({
        data: {
          epcId: id,
          actorId: userId,
          action: activityAction,
          metadata: reason ? { reason } : {},
        },
      });

      return proposal;
    });

    res.status(200).json({
      success: true,
      message: `Event Proposal marked as ${status} successfully`,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /epc/:id/close
//
// Proposer manually closes the EPC. Allowed in two scenarios:
//
//   1. VALIDATED with no deviation triggered yet
//      → straight close, no workflow check needed
//
//   2. DEVIATION_IN_PROGRESS with the deviation workflow APPROVED
//      → guard that the deviation WorkflowInstance.status === APPROVED
//        before allowing close
//
// Guards:
//   - Caller must be the EPC creator
//   - EPC must be in VALIDATED or DEVIATION_IN_PROGRESS status
//   - If DEVIATION_IN_PROGRESS, the deviation workflow must be APPROVED
// ─────────────────────────────────────────────────────────────────────────────

export const closeEpc = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const id = String(req.params.id);

    const epc = await prisma.eventProposal.findUnique({
      where: { id },
      select: { id: true, status: true, created_by_id: true },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    if (epc.created_by_id !== userId) {
      throw new ApiError(403, "Only the EPC creator can close it");
    }

    const allowedStatuses = ["VALIDATED", "DEVIATION_IN_PROGRESS"];
    if (!allowedStatuses.includes(epc.status)) {
      throw new ApiError(
        400,
        `EPC cannot be closed from status "${epc.status}". ` +
          "It must be VALIDATED or DEVIATION_IN_PROGRESS with an approved deviation workflow.",
      );
    }

    // ── Extra guard for deviation path ────────────────────────────────────
    // If the EPC is in DEVIATION_IN_PROGRESS, the deviation workflow must
    // be fully APPROVED before the proposer is allowed to close.
    if (epc.status === "DEVIATION_IN_PROGRESS") {
      const deviationWorkflow = await prisma.workflowInstance.findFirst({
        where: {
          eventProposalId: id,
          workflowType: "DEVIATION",
          isActive: true,
        },
        select: { status: true },
      });

      if (!deviationWorkflow) {
        throw new ApiError(
          400,
          "No active deviation workflow found for this EPC",
        );
      }

      if (deviationWorkflow.status !== "APPROVED") {
        throw new ApiError(
          400,
          "The deviation workflow has not been fully approved yet",
        );
      }
    }

    await prisma.$transaction([
      prisma.eventProposal.update({
        where: { id },
        data: { status: "CLOSED", updated_by_id: userId },
      }),
      prisma.activityLog.create({
        data: { epcId: id, actorId: userId, action: "EPC_CLOSED" },
      }),
    ]);

    res.status(200).json({
      success: true,
      message: "EPC closed successfully",
    });
  } catch (error) {
    next(error);
  }
};

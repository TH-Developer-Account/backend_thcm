import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { epcExportQueue } from "../../modules/map/epc.queue";
import { leadExportQueue } from "../../modules/leads/lead.queue";
import { createPendingLog } from "./importExportLog.services";

// ─────────────────────────────────────────────────────────────────────────────
// export.controller.ts
//
// Endpoints for triggering and polling EPC and lead export jobs.
// On enqueue, creates an ImportExportLog record (PENDING) so history is tracked
// from the moment the job is queued, not just on completion.
//
// Endpoints:
//   POST  /epc/export            → enqueue EPC dump job
//   GET   /epc/export/:jobId     → poll status + download URL when ready
//   POST  /leads/export          → enqueue lead export job
//   GET   /leads/export/:jobId   → poll status + download URL when ready
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared helper ─────────────────────────────────────────────────────────────
// Resolves workspaceId for the requesting user.
// workspaceId comes from DB, not JWT — consistent with the rest of the codebase.

export async function resolveWorkspaceId(userId: string): Promise<string> {
  const workspaceUser = await prisma.workspaceUser.findFirst({
    where: { userId },
    select: { workspaceId: true },
  });
  if (!workspaceUser) throw new ApiError(403, "User not part of any workspace");
  return workspaceUser.workspaceId;
}

// ── POST /epc/export ──────────────────────────────────────────────────────────
// Body: { format: 'csv' | 'xlsx', filters?: { status, departmentId, startDate, endDate } }

export const enqueueEpcExport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { format = "xlsx", filters = {} } = req.body;

    if (!["csv", "xlsx"].includes(format)) {
      throw new ApiError(400, "format must be 'csv' or 'xlsx'");
    }

    const workspaceId = await resolveWorkspaceId(userId);

    // jobId generated up front and the log row created before the job is
    // enqueued, rather than add() → createPendingLog() → job.updateData().
    // That sequence had a real race: BullMQ can start processing a job
    // within a few ms of add(), often faster than the two awaited DB calls
    // that followed it — so the worker could call markLogProcessing()
    // against a logId that was still "" (the placeholder) or hadn't been
    // written back yet, and the update would fail with "no record found".
    // Creating the log first and enqueueing with the real logId already
    // attached removes the race instead of narrowing its window.
    const jobId = randomUUID();

    const logId = await createPendingLog({
      type: "EPC_EXPORT",
      triggeredById: userId,
      workspaceId,
      jobId,
      // epcId intentionally omitted — EPC_EXPORT is workspace-wide
    });

    const job = await epcExportQueue.add(
      "epc-dump",
      {
        filters,
        format,
        requestedBy: userId,
        workspaceId,
        logId,
      },
      { jobId },
    );

    res.status(202).json({
      success: true,
      message: "EPC export job queued. This may take several minutes.",
      jobId: job.id,
      logId,
      pollUrl: `/api/v1/epc/export/${job.id}`,
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /epc/export/:jobId ────────────────────────────────────────────────────

export const getEpcExportStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { jobId } = req.params;
    const job = await epcExportQueue.getJob(jobId as string);

    if (!job) throw new ApiError(404, "Export job not found");

    const state = await job.getState();
    const progress = job.progress as Record<string, unknown>;

    res.status(200).json({
      success: true,
      jobId,
      status: state,
      progress: {
        processedEpcs: progress?.processedEpcs ?? 0,
        totalEpcs: progress?.totalEpcs ?? null,
      },
      downloadUrl: progress?.downloadUrl ?? null,
      failedReason: state === "failed" ? job.failedReason : undefined,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /leads/export ────────────────────────────────────────────────────────
// Body: { epcId?: string, format: 'csv' | 'xlsx' }

export const enqueueLeadExport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId, format = "xlsx" } = req.body;

    if (!["csv", "xlsx"].includes(format)) {
      throw new ApiError(400, "format must be 'csv' or 'xlsx'");
    }

    const workspaceId = await resolveWorkspaceId(userId);

    // Same fix as enqueueEpcExport above — see that comment for why.
    const jobId = randomUUID();

    const logId = await createPendingLog({
      type: "LEAD_EXPORT",
      triggeredById: userId,
      workspaceId,
      jobId,
      epcId: epcId ?? undefined,
    });

    const job = await leadExportQueue.add(
      "export",
      {
        epcId: epcId ?? undefined,
        format,
        requestedBy: userId,
        workspaceId,
        logId,
      },
      { jobId },
    );

    res.status(202).json({
      success: true,
      message: "Export job queued",
      jobId: job.id,
      logId,
      pollUrl: `/api/v1/leads/export/${job.id}`,
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /leads/export/:jobId ──────────────────────────────────────────────────

export const getLeadExportStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { jobId } = req.params;
    const job = await leadExportQueue.getJob(jobId as string);

    if (!job) throw new ApiError(404, "Export job not found");

    const state = await job.getState();
    const progress = job.progress as Record<string, unknown>;

    res.status(200).json({
      success: true,
      jobId,
      status: state,
      downloadUrl: progress?.downloadUrl ?? null,
      failedReason: state === "failed" ? job.failedReason : undefined,
    });
  } catch (error) {
    next(error);
  }
};

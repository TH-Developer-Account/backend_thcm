import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import { epcExportQueue } from "../queues/epc.queue";
import { leadExportQueue } from "../queues/lead.queue";
import { createPendingLog } from "../services/importExportLog.services";
import ApiError from "../utils/apiError";
import { ImportExportType } from "../services/importExportLog.services";

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

async function resolveWorkspaceId(userId: string): Promise<string> {
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

    const job = await epcExportQueue.add("epc-dump", {
      filters,
      format,
      requestedBy: userId,
      logId: "", // placeholder — updated after log creation
    });

    const logId = await createPendingLog({
      type: "EPC_EXPORT",
      triggeredById: userId,
      workspaceId,
      jobId: job.id!,
      // epcId intentionally omitted — EPC_EXPORT is workspace-wide
    });

    await job.updateData({ ...job.data, logId });

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

    const job = await leadExportQueue.add("export", {
      epcId: epcId ?? undefined,
      format,
      requestedBy: userId,
      logId: "", // placeholder — updated after log creation
    });

    const logId = await createPendingLog({
      type: "LEAD_EXPORT",
      triggeredById: userId,
      workspaceId,
      jobId: job.id!,
      epcId: epcId ?? undefined,
    });

    await job.updateData({ ...job.data, logId });

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

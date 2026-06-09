import { Request, Response, NextFunction } from "express";
import { epcExportQueue } from "../queues/epc.queue";
import { leadExportQueue } from "../queues/lead.queue";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// epcExport.controller.ts
//
// Admin-only endpoints for triggering and polling full EPC dump jobs.
//
// Admin guard is handled by middleware on the route — the controller
// trusts that req.user is an authenticated admin by the time it runs.
//
// Endpoints:
//   POST  /epc/export            → enqueue EPC dump job
//   GET   /epc/export/:jobId     → poll status + download URL when ready
// ─────────────────────────────────────────────────────────────────────────────

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

    const job = await epcExportQueue.add("epc-dump", {
      filters,
      format,
      requestedBy: userId,
    });

    res.status(202).json({
      success: true,
      message: "EPC export job queued. This may take several minutes.",
      jobId: job.id,
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

    const job = await leadExportQueue.add("export", {
      epcId: epcId ?? undefined,
      format,
      requestedBy: userId,
    });

    res.status(202).json({
      success: true,
      message: "Export job queued",
      jobId: job.id,
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

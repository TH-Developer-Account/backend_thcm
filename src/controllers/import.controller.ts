import { Request, Response, NextFunction } from "express";
import { leadImportQueue } from "../queues/lead.queue";
import { uploadToS3 } from "../services/aws-s3.services";
import ApiError from "../utils/apiError";
import { isSupportedMimeType } from "../utils/fileParser";

// ─────────────────────────────────────────────────────────────────────────────
// leadImportExport.controller.ts
//
// Thin controller layer — validates input, enqueues jobs, returns jobId.
// All heavy lifting is in the service layer (called by workers).
//
// Endpoints:
//   POST  /leads/import              → upload file to S3, enqueue import job
//   GET   /leads/import/:jobId       → poll import job status
//   POST  /leads/export              → enqueue export job
//   GET   /leads/export/:jobId       → poll export job status + download URL
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /leads/import ────────────────────────────────────────────────────────
// Expects multipart/form-data with:
//   file    — CSV or XLSX file
//   epcId   — target EPC UUID (form field)

export const enqueueLeadImport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const file = req.file;
    if (!file)
      throw new ApiError(400, "file is required (multipart/form-data)");

    const { epcId } = req.body;
    if (!epcId) throw new ApiError(400, "epcId is required");

    if (!isSupportedMimeType(file.mimetype)) {
      throw new ApiError(
        400,
        "Unsupported file type. Upload a CSV or XLSX file",
      );
    }

    // Upload file to S3 before enqueuing — the worker process downloads it
    // from S3 directly. We never pass large buffers through Redis.
    const timestamp = Date.now();
    const s3Key = `imports/leads/${epcId}/${timestamp}-${file.originalname}`;
    await uploadToS3(s3Key, file.buffer, file.mimetype);

    const job = await leadImportQueue.add("import", {
      epcId,
      fileS3Key: s3Key,
      fileMimeType: file.mimetype,
      requestedBy: userId,
    });

    res.status(202).json({
      success: true,
      message: "Import job queued",
      jobId: job.id,
      pollUrl: `/api/v1/leads/import/${job.id}`,
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /leads/import/:jobId ──────────────────────────────────────────────────

export const getLeadImportStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { jobId } = req.params;
    const job = await leadImportQueue.getJob(jobId as string);

    if (!job) throw new ApiError(404, "Import job not found");

    const state = await job.getState();
    const progress = job.progress as Record<string, unknown>;

    res.status(200).json({
      success: true,
      jobId,
      status: state,
      progress: {
        totalRows: progress?.totalRows ?? 0,
        processedRows: progress?.processedRows ?? 0,
        failedRows: progress?.failedRows ?? 0,
      },
      errors: progress?.errors ?? [],
      failedReason: state === "failed" ? job.failedReason : undefined,
    });
  } catch (error) {
    next(error);
  }
};

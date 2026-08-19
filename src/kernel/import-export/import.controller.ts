import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { leadImportQueue } from "@leads/lead.queue";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import { createPendingLog, attachJobIdToLog } from "./importExportLog.services";
import { isSupportedMimeType } from "./utils/fileParser";

// ─────────────────────────────────────────────────────────────────────────────
// leadImport.controller.ts
//
// Thin controller layer — validates input, creates an ImportExportLog record,
// enqueues the job, returns jobId and logId.
//
// Endpoints:
//   POST  /leads/import              → upload file to S3, enqueue import job
//   GET   /leads/import/:jobId       → poll import job status
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

    const workspaceUser = await prisma.workspaceUser.findFirst({
      where: { userId },
      select: { workspaceId: true },
    });
    if (!workspaceUser)
      throw new ApiError(403, "User not part of any workspace");

    const timestamp = Date.now();
    const s3Key = `imports/leads/${epcId}/${timestamp}-${file.originalname}`;
    await uploadToS3(s3Key, file.buffer, file.mimetype);

    // ── Pre-generate the log ID and create the log row BEFORE enqueueing ────
    // WHY: the job must carry the real logId from its very first read by the
    // worker. Enqueueing first and patching logId in afterward (the previous
    // approach) races against the worker picking up the job before the patch
    // lands — exactly the bug that just happened. jobId isn't known yet at
    // this point (BullMQ only assigns it on .add()), so the log is created
    // with a temporary placeholder and patched with the real jobId after
    // enqueueing — that patch is safe since nothing reads jobId mid-flight.
    const logId = randomUUID();

    await createPendingLog({
      id: logId,
      type: "LEAD_IMPORT",
      triggeredById: userId,
      workspaceId: workspaceUser.workspaceId,
      jobId: "pending",
      epcId,
    });

    const job = await leadImportQueue.add("import", {
      epcId,
      fileS3Key: s3Key,
      fileMimeType: file.mimetype,
      requestedBy: userId,
      logId,
    });

    await attachJobIdToLog(logId, job.id!);

    res.status(202).json({
      success: true,
      message: "Import job queued",
      jobId: job.id,
      logId,
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

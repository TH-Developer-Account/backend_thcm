import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import { getSignedReportUrl } from "@shared/utils/aws-s3.services";
import ApiError from "@shared/utils/apiError";
import {
  listLogs,
  listLogsForWorkspace,
  findLogById,
} from "./importExportLog.services";
import { ImportExportType } from "./importExportLog.services";

// ─────────────────────────────────────────────────────────────────────────────
// importExportLog.controller.ts
//
// Endpoints:
//   GET /leads/import/history?epcId=   → LEAD_IMPORT history for an EPC
//   GET /leads/export/history?epcId=   → LEAD_EXPORT history for an EPC
//   GET /epc/export/history            → EPC_EXPORT history (workspace-wide)
//   GET /import-export/:logId/file     → fresh pre-signed URL for output file
//   GET /import-export/:logId/errors   → fresh pre-signed URL for error Excel
//
// Access control:
//   - Regular users see only their own records (triggeredById = userId)
//   - Admins (isSuperAdmin = true on WorkspaceUser) see all records
//
// WHY generate fresh pre-signed URLs on every GET:
//   AWS pre-signed URLs cap at 7 days. Storing them in DB would mean they
//   expire. Storing only the S3 key and signing on demand gives permanent access.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared helper ─────────────────────────────────────────────────────────────

async function resolveUserContext(
  userId: string,
): Promise<{ workspaceId: string; isAdmin: boolean }> {
  const workspaceUser = await prisma.workspaceUser.findFirst({
    where: { userId },
    select: { workspaceId: true, isSuperAdmin: true },
  });
  if (!workspaceUser) throw new ApiError(403, "User not part of any workspace");
  return {
    workspaceId: workspaceUser.workspaceId,
    isAdmin: workspaceUser.isSuperAdmin,
  };
}

// Strips S3 keys from the listing response — callers use the dedicated
// /file and /errors endpoints to get URLs. This keeps the listing lean
// and avoids generating pre-signed URLs for every row in the list.
function formatLogForListing(log: {
  id: string;
  type: ImportExportType;
  status: string;
  totalRecords: number | null;
  successRecords: number | null;
  failedRecords: number | null;
  errorFileS3Key: string | null;
  created_at: Date;
  triggeredBy: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
  };
  epc: {
    id: string;
    proposal_number: string;
  } | null;
}) {
  return {
    id: log.id,
    type: log.type,
    status: log.status,
    totalRecords: log.totalRecords,
    successRecords: log.successRecords,
    failedRecords: log.failedRecords,
    hasErrorFile: !!log.errorFileS3Key,
    errorFileS3Key: log.errorFileS3Key,
    createdAt: log.created_at,
    triggeredBy: log.triggeredBy,
    epc: log.epc,
  };
}

// ── GET /leads/import/history ─────────────────────────────────────────────────

export const getLeadImportHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { type } = req.body;
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { isAdmin } = await resolveUserContext(userId);
    const logs = await listLogs(type, userId, isAdmin);
    res.status(200).json({
      success: true,
      data: logs.map(formatLogForListing),
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /import-export/:logId/file ────────────────────────────────────────────
// Returns a fresh pre-signed URL for the output file (export result).

export const getOutputFileUrl = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { logId } = req.params;
    const log = await findLogById(logId as string);

    if (!log) throw new ApiError(404, "Log record not found");
    if (!log.fileS3Key)
      throw new ApiError(404, "No output file available for this job");

    // Access check: own record or admin
    const { isAdmin } = await resolveUserContext(userId);
    if (!isAdmin && log.triggeredById !== userId) {
      throw new ApiError(403, "Forbidden");
    }

    // 7 days is the AWS maximum for pre-signed URLs.
    // We regenerate on every request so access never expires.
    const url = await getSignedReportUrl(log.fileS3Key, 60 * 60 * 24 * 7);

    res.status(200).json({ success: true, url });
  } catch (error) {
    next(error);
  }
};

// ── GET /import-export/:logId/errors ─────────────────────────────────────────
// Returns a fresh pre-signed URL for the error Excel (LEAD_IMPORT only).

export const getErrorFileUrl = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { logId } = req.params;
    const log = await findLogById(logId as string);

    if (!log) throw new ApiError(404, "Log record not found");
    if (!log.errorFileS3Key) {
      throw new ApiError(
        404,
        "No error file available — either no rows failed or this is not an import job",
      );
    }

    const { isAdmin } = await resolveUserContext(userId);
    if (!isAdmin && log.triggeredById !== userId) {
      throw new ApiError(403, "Forbidden");
    }

    const url = await getSignedReportUrl(log.errorFileS3Key, 60 * 60 * 24 * 7);

    res.status(200).json({ success: true, url });
  } catch (error) {
    next(error);
  }
};

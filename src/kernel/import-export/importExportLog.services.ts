import { prisma } from "@shared/config/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// importExportLog.service.ts
//
// Single point of contact for all reads/writes to the ImportExportLog table.
// Workers and controllers never query this table directly.
//
// Lifecycle:
//   createPending()   → called by controller on enqueue         (PENDING)
//   markProcessing()  → called by worker when job starts        (PROCESSING)
//   markCompleted()   → called by worker on success             (COMPLETED)
//   markFailed()      → called by worker on unrecoverable error (FAILED)
//   listForEpc()      → history scoped to an EPC
//   listForWorkspace() → history for EPC_EXPORT (workspace-wide)
//   findById()        → single record fetch (for file URL generation)
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

export type ImportExportType = "LEAD_IMPORT" | "LEAD_EXPORT" | "EPC_EXPORT";
export type ImportExportStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export type CreatePendingLogInput = {
  id?: string;
  type: ImportExportType;
  triggeredById: string;
  workspaceId: string;
  jobId: string;
  epcId?: string;
};

export type MarkCompletedInput = {
  totalRecords: number;
  successRecords: number;
  failedRecords: number;
  fileS3Key?: string;
  errorFileS3Key?: string;
};

// ── Write operations ───────────────────────────────────────────────────────────

export async function createPendingLog(
  input: CreatePendingLogInput,
): Promise<string> {
  const log = await prisma.importExportLog.create({
    data: {
      id: input.id,
      type: input.type,
      status: "PENDING",
      triggeredById: input.triggeredById,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      epcId: input.epcId ?? null,
    },
    select: { id: true },
  });
  return log.id;
}

export async function attachJobIdToLog(
  logId: string,
  jobId: string,
): Promise<void> {
  await prisma.importExportLog.update({
    where: { id: logId },
    data: { jobId },
  });
}

export async function markLogProcessing(logId: string): Promise<void> {
  await prisma.importExportLog.update({
    where: { id: logId },
    data: { status: "PROCESSING" },
  });
}

export async function markLogCompleted(
  logId: string,
  input: MarkCompletedInput,
): Promise<void> {
  await prisma.importExportLog.update({
    where: { id: logId },
    data: {
      status: "COMPLETED",
      totalRecords: input.totalRecords,
      successRecords: input.successRecords,
      failedRecords: input.failedRecords,
      fileS3Key: input.fileS3Key ?? null,
      errorFileS3Key: input.errorFileS3Key ?? null,
    },
  });
}

export async function markLogFailed(
  logId: string,
  reason: string,
): Promise<void> {
  await prisma.importExportLog.update({
    where: { id: logId },
    data: {
      status: "FAILED",
      failureReason: reason,
    },
  });
}

// ── Read operations ────────────────────────────────────────────────────────────

// Used by file URL endpoints — returns only the fields needed to build a URL
export async function findLogById(logId: string) {
  return prisma.importExportLog.findUnique({
    where: { id: logId },
    select: {
      id: true,
      type: true,
      status: true,
      fileS3Key: true,
      errorFileS3Key: true,
      triggeredById: true,
      workspaceId: true,
    },
  });
}

// Listing scoped to an EPC — for LEAD_IMPORT and LEAD_EXPORT history
export async function listLogs(
  type: ImportExportType,
  requestingUserId: string,
  isAdmin: boolean,
) {
  return prisma.importExportLog.findMany({
    where: {
      type,
      // Admins see all; regular users see only their own
      ...(!isAdmin && { triggeredById: requestingUserId }),
    },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      totalRecords: true,
      successRecords: true,
      failedRecords: true,
      fileS3Key: true,
      errorFileS3Key: true,
      failureReason: true,
      created_at: true,
      triggeredBy: {
        select: { id: true, first_name: true, last_name: true, email: true },
      },
      epc: {
        select: { id: true, proposal_number: true },
      },
    },
  });
}

// Listing workspace-wide — for EPC_EXPORT history
export async function listLogsForWorkspace(
  workspaceId: string,
  requestingUserId: string,
  isAdmin: boolean,
) {
  return prisma.importExportLog.findMany({
    where: {
      workspaceId,
      type: "EPC_EXPORT",
      ...(!isAdmin && { triggeredById: requestingUserId }),
    },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      totalRecords: true,
      successRecords: true,
      failedRecords: true,
      fileS3Key: true,
      errorFileS3Key: true,
      failureReason: true,
      created_at: true,
      triggeredBy: {
        select: { id: true, first_name: true, last_name: true, email: true },
      },
      epc: {
        select: { id: true, proposal_number: true },
      },
    },
  });
}

import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { uploadReportPdf, deleteReportPdf } from "../services/aws-s3.services";
import { getValidatorForApp } from "../utils/validators.constant";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Resolves the app key for a given EPC by walking EPC → active workflow → template → app.
// We need the app key to look up the correct validator from APP_VALIDATORS.
async function resolveAppKeyForEpc(epcId: string): Promise<string> {
  const workflow = await prisma.workflowInstance.findFirst({
    where: { eventProposalId: epcId, isActive: true },
    select: {
      template: {
        select: { app: { select: { key: true } } },
      },
    },
  });

  if (!workflow) {
    throw new ApiError(404, "No active workflow found for this EPC");
  }

  return workflow.template.app.key;
}

// Extracts the PDF buffer from the multipart request.
// Assumes multer (or similar) middleware has attached `req.file`.
function extractPdfBuffer(req: Request): Buffer {
  if (!req.file) {
    throw new ApiError(400, "PDF file is required");
  }
  if (req.file.mimetype !== "application/pdf") {
    throw new ApiError(400, "Only PDF files are accepted");
  }
  return req.file.buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /epc/:id/report
//
// Proposer submits the event report PDF after marking the EPC as CONDUCTED.
//
// Guards:
//   - Caller must be the EPC creator
//   - EPC must be in CONDUCTED status
//   - Report must not already exist (one report per EPC)
//
// Multipart body fields:
//   file         — PDF file (required)
//   description  — string (optional)
//   notes        — string (optional)
//   actualSpend  — number (required)
// ─────────────────────────────────────────────────────────────────────────────

export const submitReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const epcId = String(req.params.epcId);
    const { description, notes, actualSpend } = req.body;

    if (!actualSpend || isNaN(Number(actualSpend))) {
      throw new ApiError(400, "actualSpend is required and must be a number");
    }

    // ── Load EPC ──────────────────────────────────────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true, status: true, created_by_id: true },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    if (epc.created_by_id !== userId) {
      throw new ApiError(403, "Only the EPC creator can submit the report");
    }

    if (epc.status !== "CONDUCTED") {
      throw new ApiError(
        400,
        "Report can only be submitted after the EPC is marked as CONDUCTED",
      );
    }

    // ── Guard: no duplicate report ────────────────────────────────────────
    const existing = await prisma.eventReport.findUnique({
      where: { epcId },
      select: { id: true },
    });

    if (existing) {
      throw new ApiError(409, "A report already exists for this EPC.");
    }

    // ── Resolve validator for this EPC's app ──────────────────────────────
    const appKey = await resolveAppKeyForEpc(epcId);
    const validatorId = getValidatorForApp(appKey);

    // ── Upload PDF to S3 ──────────────────────────────────────────────────
    const pdfBuffer = extractPdfBuffer(req);
    const { s3Key, fileUrl } = await uploadReportPdf(epcId, pdfBuffer);

    // ── Create report + transition EPC status atomically ─────────────────
    const [report] = await prisma.$transaction([
      prisma.eventReport.create({
        data: {
          epcId,
          s3Key,
          fileUrl,
          description: description?.trim() ?? null,
          notes: notes?.trim() ?? null,
          actualSpend: Number(actualSpend),
          validatorId,
          status: "SUBMITTED",
        },
      }),
      prisma.eventProposal.update({
        where: { id: epcId },
        data: { status: "REPORT_SUBMITTED" },
      }),
      prisma.activityLog.create({
        data: {
          epcId,
          actorId: userId,
          action: "REPORT_SUBMITTED",
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      message: "Report submitted successfully",
      data: report,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /epc/:id/report
//
// Proposer resubmits the report after validator rejection.
// The old PDF is deleted from S3 and replaced with the new one.
//
// Guards:
//   - Caller must be the EPC creator
//   - EPC must be in REPORT_REJECTED status
//   - Report must exist
// ─────────────────────────────────────────────────────────────────────────────

export const resubmitReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const epcId = String(req.params.epcId);
    const { description, notes, actualSpend } = req.body;

    // ── Load EPC ──────────────────────────────────────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true, status: true, created_by_id: true },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    if (epc.created_by_id !== userId) {
      throw new ApiError(403, "Only the EPC creator can resubmit the report");
    }

    if (epc.status !== "REPORT_REJECTED") {
      throw new ApiError(
        400,
        "Report can only be resubmitted after it has been rejected",
      );
    }

    // ── Load existing report ──────────────────────────────────────────────
    const existingReport = await prisma.eventReport.findUnique({
      where: { epcId },
      select: { id: true, s3Key: true },
    });

    if (!existingReport) throw new ApiError(404, "Report not found");

    // ── Upload new PDF, then delete old one ───────────────────────────────
    // Upload first — if upload fails, the old file is still intact.
    const pdfBuffer = extractPdfBuffer(req);
    const { s3Key: newS3Key, fileUrl: newFileUrl } = await uploadReportPdf(
      epcId,
      pdfBuffer,
    );

    await deleteReportPdf(existingReport.s3Key);

    // ── Build update payload (only supplied fields) ───────────────────────
    const updateData: Record<string, any> = {
      s3Key: newS3Key,
      fileUrl: newFileUrl,
      status: "SUBMITTED",
      rejectionReason: null,
      resubmittedAt: new Date(),
    };

    if (description !== undefined) updateData.description = description.trim();
    if (notes !== undefined) updateData.notes = notes.trim();
    if (actualSpend !== undefined) updateData.actualSpend = Number(actualSpend);

    // ── Update report + transition EPC status atomically ──────────────────
    const [report] = await prisma.$transaction([
      prisma.eventReport.update({
        where: { epcId },
        data: updateData,
      }),
      prisma.eventProposal.update({
        where: { id: epcId },
        data: { status: "REPORT_SUBMITTED" },
      }),
      prisma.activityLog.create({
        data: {
          epcId,
          actorId: userId,
          action: "REPORT_RESUBMITTED",
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      message: "Report resubmitted successfully",
      data: report,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /epc/:id/report
//
// Returns the event report for a given EPC.
// ─────────────────────────────────────────────────────────────────────────────

export const getReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const epcId = String(req.params.epcId);

    const report = await prisma.eventReport.findUnique({
      where: { epcId },
      include: {
        validator: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
      },
    });

    if (!report) throw new ApiError(404, "Report not found");

    res.status(200).json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:reportId/validate
//
// Validator approves the report.
//
// Guards:
//   - Caller must be the configured validator for this EPC's app
//   - Report must be in SUBMITTED status
//
// Transitions:
//   - Report → VALIDATED
//   - EPC    → VALIDATED
// ─────────────────────────────────────────────────────────────────────────────

export const validateReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { reportId } = req.params;

    // ── Load report with EPC context ──────────────────────────────────────
    const report = await prisma.eventReport.findUnique({
      where: { id: reportId as string },
      select: {
        id: true,
        epcId: true,
        status: true,
        validatorId: true,
      },
    });

    if (!report) throw new ApiError(404, "Report not found");

    if (report.validatorId !== userId) {
      throw new ApiError(403, "You are not the validator for this report");
    }

    if (report.status !== "SUBMITTED") {
      throw new ApiError(
        400,
        `Report cannot be validated — current status is ${report.status}`,
      );
    }

    // ── Validate report + transition EPC atomically ───────────────────────
    await prisma.$transaction([
      prisma.eventReport.update({
        where: { id: reportId as string },
        data: {
          status: "VALIDATED",
          validatedAt: new Date(),
          rejectionReason: null,
        },
      }),
      prisma.eventProposal.update({
        where: { id: report.epcId },
        data: { status: "VALIDATED" },
      }),
      prisma.activityLog.create({
        data: {
          epcId: report.epcId,
          actorId: userId,
          action: "REPORT_VALIDATED",
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      message: "Report validated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:reportId/reject
//
// Validator rejects the report with a mandatory reason.
// The proposer must then resubmit via PATCH /epc/:id/report.
//
// Guards:
//   - Caller must be the configured validator for this EPC's app
//   - Report must be in SUBMITTED status
//
// Transitions:
//   - Report → REJECTED (with rejectionReason)
//   - EPC    → REPORT_REJECTED
// ─────────────────────────────────────────────────────────────────────────────

export const rejectReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { reportId } = req.params;
    const { reason } = req.body;

    if (!reason || String(reason).trim().length < 5) {
      throw new ApiError(
        400,
        "A rejection reason of at least 5 characters is required",
      );
    }

    // ── Load report ───────────────────────────────────────────────────────
    const report = await prisma.eventReport.findUnique({
      where: { id: reportId as string },
      select: {
        id: true,
        epcId: true,
        status: true,
        validatorId: true,
      },
    });

    if (!report) throw new ApiError(404, "Report not found");

    if (report.validatorId !== userId) {
      throw new ApiError(403, "You are not the validator for this report");
    }

    if (report.status !== "SUBMITTED") {
      throw new ApiError(
        400,
        `Report cannot be rejected — current status is ${report.status}`,
      );
    }

    // ── Reject report + transition EPC atomically ─────────────────────────
    await prisma.$transaction([
      prisma.eventReport.update({
        where: { id: reportId as string },
        data: {
          status: "REJECTED",
          rejectionReason: String(reason).trim(),
        },
      }),
      prisma.eventProposal.update({
        where: { id: report.epcId },
        data: { status: "REPORT_REJECTED" },
      }),
      prisma.activityLog.create({
        data: {
          epcId: report.epcId,
          actorId: userId,
          action: "REPORT_REJECTED",
          metadata: { reason: String(reason).trim() },
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      message: "Report rejected. The proposer has been notified to resubmit.",
    });
  } catch (error) {
    next(error);
  }
};

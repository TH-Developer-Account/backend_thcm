import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import {
  uploadReportImage,
  deleteReportImage,
  getSignedImageUrl,
} from "../services/aws-s3.services";
import { getValidatorForApp } from "../utils/validators.constant";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_IMAGE_COUNT = 4;
const VALID_IMAGE_POSITIONS = [1, 2, 3, 4] as const;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

type ImagePosition = (typeof VALID_IMAGE_POSITIONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Resolves the app key for an EPC by walking EPC → active workflow → template → app.
// Needed to look up the correct validator from APP_VALIDATORS.
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

// Extracts and validates a named image file from the multipart request.
// multer stores named fields in req.files as a Record<fieldName, Express.Multer.File[]>.
function extractImageFile(
  files: Record<string, Express.Multer.File[]>,
  position: ImagePosition,
): Express.Multer.File {
  const fieldName = `image_${position}`;
  const fileArr = files[fieldName];

  if (!fileArr || fileArr.length === 0) {
    throw new ApiError(400, `image_${position} is required`);
  }

  const file = fileArr[0];

  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    throw new ApiError(
      400,
      `image_${position}: only JPEG, PNG, and WebP images are accepted`,
    );
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new ApiError(
      400,
      `image_${position}: file size must not exceed 5 MB`,
    );
  }

  return file;
}

// Hydrates pre-signed URLs for all images on a report.
// Returns images sorted by position for consistent response shape.
async function hydrateImageUrls(
  images: { id: string; position: number; s3Key: string; fileUrl: string }[],
): Promise<{ id: string; position: number; url: string }[]> {
  const sorted = [...images].sort((a, b) => a.position - b.position);

  return Promise.all(
    sorted.map(async (img) => ({
      id: img.id,
      position: img.position,
      url: await getSignedImageUrl(img.s3Key),
    })),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:epcId/submit
//
// Proposer submits the event report after the EPC is marked CONDUCTED.
// Exactly 4 images are required (fields: image_1, image_2, image_3, image_4).
//
// Multipart fields:
//   image_1..image_4     — image files (JPEG/PNG/WebP, max 5 MB each, required)
//   outcomeStatus        — "SUCCESSFUL" | "PARTIALLY_SUCCESSFUL" | "UNSUCCESSFUL" (required)
//   totalLeadsGenerated  — integer (required)
//   approvedEventCost    — decimal (required)
//   expectedConversion   — string (optional)
//   remarks              — string (optional)
//
// Guards:
//   - Caller must be the EPC creator
//   - EPC must be in CONDUCTED status
//   - Report must not already exist
//
// Transitions:
//   - EPC → REPORT_SUBMITTED
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
    const files = req.files as Record<string, Express.Multer.File[]>;

    const {
      outcomeStatus,
      totalLeadsGenerated,
      approvedEventCost,
      expectedConversion,
      remarks,
    } = req.body;

    // ── Validate required scalar fields ───────────────────────────────────
    if (!outcomeStatus) {
      throw new ApiError(400, "outcomeStatus is required");
    }
    if (
      !["SUCCESSFUL", "PARTIALLY_SUCCESSFUL", "UNSUCCESSFUL"].includes(
        outcomeStatus,
      )
    ) {
      throw new ApiError(
        400,
        "outcomeStatus must be SUCCESSFUL, PARTIALLY_SUCCESSFUL, or UNSUCCESSFUL",
      );
    }
    if (
      totalLeadsGenerated === undefined ||
      isNaN(Number(totalLeadsGenerated))
    ) {
      throw new ApiError(
        400,
        "totalLeadsGenerated is required and must be a number",
      );
    }
    if (!approvedEventCost || isNaN(Number(approvedEventCost))) {
      throw new ApiError(
        400,
        "approvedEventCost is required and must be a number",
      );
    }

    // ── Validate all 4 image files up front before any DB/S3 work ─────────
    const imageFiles = VALID_IMAGE_POSITIONS.map((pos) =>
      extractImageFile(files ?? {}, pos),
    );

    // ── Load and guard EPC ────────────────────────────────────────────────
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
      throw new ApiError(409, "A report already exists for this EPC");
    }

    // ── Resolve validator ─────────────────────────────────────────────────
    const appKey = await resolveAppKeyForEpc(epcId);
    const validatorId = getValidatorForApp(appKey);

    if (!validatorId) {
      throw new ApiError(500, `No validator configured for app "${appKey}"`);
    }

    // ── Upload all 4 images to S3 ─────────────────────────────────────────
    // Upload before DB write — if any upload fails, nothing is persisted.
    const uploadResults = await Promise.all(
      imageFiles.map((file, index) =>
        uploadReportImage(epcId, index + 1, file.buffer, file.mimetype),
      ),
    );

    // ── Create report + images + transition EPC status atomically ─────────
    const report = await prisma.$transaction(async (tx) => {
      const created = await tx.eventReport.create({
        data: {
          epcId,
          outcomeStatus,
          totalLeadsGenerated: Number(totalLeadsGenerated),
          approvedEventCost: Number(approvedEventCost),
          expectedConversion: expectedConversion?.trim() ?? null,
          remarks: remarks?.trim() ?? null,
          validatorId,
          status: "SUBMITTED",
          images: {
            create: uploadResults.map((result, index) => ({
              position: index + 1,
              s3Key: result.s3Key,
              fileUrl: result.fileUrl,
            })),
          },
        },
        include: { images: true },
      });

      await tx.eventProposal.update({
        where: { id: epcId },
        data: { status: "REPORT_SUBMITTED" },
      });

      await tx.activityLog.create({
        data: {
          epcId,
          actorId: userId,
          action: "REPORT_SUBMITTED",
        },
      });

      return created;
    });

    res.status(201).json({
      success: true,
      message: "Report submitted successfully",
      data: { ...report, images: await hydrateImageUrls(report.images) },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /report/:epcId/resubmit
//
// Proposer resubmits after validator rejection.
// All scalar fields are optional — only supplied ones are updated.
// Images are selectively replaced — send only the positions you want to swap.
//
// Multipart fields:
//   image_1..image_4     — optional; only sent positions are replaced
//   outcomeStatus        — optional
//   totalLeadsGenerated  — optional
//   approvedEventCost    — optional
//   expectedConversion   — optional
//   remarks              — optional
//
// Guards:
//   - Caller must be the EPC creator
//   - EPC must be in REPORT_REJECTED status
//   - Report must exist
//
// Transitions:
//   - Report → SUBMITTED (resets for re-review)
//   - EPC    → REPORT_SUBMITTED
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
    const files = req.files as Record<string, Express.Multer.File[]>;

    const {
      outcomeStatus,
      totalLeadsGenerated,
      approvedEventCost,
      expectedConversion,
      remarks,
    } = req.body;

    // ── Load and guard EPC ────────────────────────────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true, status: true, created_by_id: true },
    });

    if (!epc) throw new ApiError(404, "EPC not found");

    if (epc.created_by_id !== userId) {
      throw new ApiError(403, "Only the EPC creator can resubmit the report");
    }

    if (epc.status !== "CLARIFY_REPORT") {
      throw new ApiError(
        400,
        "Report can only be resubmitted after it has been requested for clarification",
      );
    }

    // ── Load existing report + images ─────────────────────────────────────
    const existingReport = await prisma.eventReport.findUnique({
      where: { epcId },
      select: {
        id: true,
        images: { select: { id: true, position: true, s3Key: true } },
      },
    });

    if (!existingReport) throw new ApiError(404, "Report not found");

    // ── Determine which positions are being replaced ───────────────────────
    // Only validate files that were actually sent — other positions untouched.
    const positionsToReplace = VALID_IMAGE_POSITIONS.filter(
      (pos) => files?.[`image_${pos}`]?.length > 0,
    );

    const replacementFiles = positionsToReplace.map(
      (pos) => extractImageFile(files, pos), // validates mime + size
    );

    // ── Validate optional scalar fields ───────────────────────────────────
    if (
      outcomeStatus !== undefined &&
      !["SUCCESSFUL", "PARTIALLY_SUCCESSFUL", "UNSUCCESSFUL"].includes(
        outcomeStatus,
      )
    ) {
      throw new ApiError(
        400,
        "outcomeStatus must be SUCCESSFUL, PARTIALLY_SUCCESSFUL, or UNSUCCESSFUL",
      );
    }
    if (
      totalLeadsGenerated !== undefined &&
      isNaN(Number(totalLeadsGenerated))
    ) {
      throw new ApiError(400, "totalLeadsGenerated must be a number");
    }
    if (approvedEventCost !== undefined && isNaN(Number(approvedEventCost))) {
      throw new ApiError(400, "approvedEventCost must be a number");
    }

    // ── Upload replacements first — old files still intact if any fail ─────
    const uploadResults = await Promise.all(
      positionsToReplace.map((pos, index) =>
        uploadReportImage(
          epcId,
          pos,
          replacementFiles[index].buffer,
          replacementFiles[index].mimetype,
        ),
      ),
    );

    // ── Delete old S3 objects for replaced positions ───────────────────────
    // Fire-and-forget deletions after successful uploads — stale S3 objects
    // are preferable to a partially failed state where nothing was updated.
    const existingImageMap = new Map(
      existingReport.images.map((img) => [img.position, img.s3Key]),
    );

    await Promise.allSettled(
      positionsToReplace.map((pos) => {
        const oldKey = existingImageMap.get(pos);
        return oldKey ? deleteReportImage(oldKey) : Promise.resolve();
      }),
    );

    // ── Build scalar update payload — only supplied fields ────────────────
    const scalarUpdate: Record<string, unknown> = {
      status: "SUBMITTED",
      rejectionReason: null,
      resubmittedAt: new Date(),
    };

    if (outcomeStatus !== undefined) scalarUpdate.outcomeStatus = outcomeStatus;
    if (totalLeadsGenerated !== undefined)
      scalarUpdate.totalLeadsGenerated = Number(totalLeadsGenerated);
    if (approvedEventCost !== undefined)
      scalarUpdate.approvedEventCost = Number(approvedEventCost);
    if (expectedConversion !== undefined)
      scalarUpdate.expectedConversion = expectedConversion.trim();
    if (remarks !== undefined) scalarUpdate.remarks = remarks.trim();

    // ── Update report + upsert replaced images + transition EPC atomically ─
    const report = await prisma.$transaction(async (tx) => {
      const updated = await tx.eventReport.update({
        where: { epcId },
        data: {
          ...scalarUpdate,
          images: {
            // upsert each replaced position — creates if missing, updates if exists
            upsert: positionsToReplace.map((pos, index) => ({
              where: {
                reportId_position: {
                  reportId: existingReport.id,
                  position: pos,
                },
              },
              create: {
                position: pos,
                s3Key: uploadResults[index].s3Key,
                fileUrl: uploadResults[index].fileUrl,
              },
              update: {
                s3Key: uploadResults[index].s3Key,
                fileUrl: uploadResults[index].fileUrl,
              },
            })),
          },
        },
        include: { images: true },
      });

      await tx.eventProposal.update({
        where: { id: epcId },
        data: { status: "REPORT_SUBMITTED" },
      });

      await tx.activityLog.create({
        data: {
          epcId,
          actorId: userId,
          action: "REPORT_RESUBMITTED",
        },
      });

      return updated;
    });

    res.status(200).json({
      success: true,
      message: "Report resubmitted successfully",
      data: { ...report, images: await hydrateImageUrls(report.images) },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /report/:epcId
//
// Returns the event report with pre-signed image URLs ordered by position.
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
        images: true,
      },
    });

    if (!report) throw new ApiError(404, "Report not found");

    const { images, ...reportData } = report;

    res.status(200).json({
      success: true,
      data: {
        ...reportData,
        images: await hydrateImageUrls(images),
      },
    });
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

    const report = await prisma.eventReport.findUnique({
      where: { id: reportId as string },
      select: { id: true, epcId: true, status: true, validatorId: true },
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
// The proposer must then resubmit via PATCH /report/:epcId/resubmit.
//
// Guards:
//   - Caller must be the configured validator for this EPC's app
//   - Report must be in SUBMITTED status
//
// Transitions:
//   - Report → REJECTED (with rejectionReason)
//   - EPC    → REPORT_REJECTED
// ─────────────────────────────────────────────────────────────────────────────

export const requestReportClarification = async (
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
        "A clarification reason of at least 5 characters is required",
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
        `Clarification can only be requested on a SUBMITTED report. Current status: ${report.status}`,
      );
    }

    // ── Request clarification + transition EPC atomically ─────────────────
    await prisma.$transaction([
      prisma.eventReport.update({
        where: { id: reportId as string },
        data: {
          status: "CLARIFICATION_REQUESTED",
          clarificationReason: String(reason).trim(),
        },
      }),
      prisma.eventProposal.update({
        where: { id: report.epcId },
        data: { status: "CLARIFY_REPORT" },
      }),
      prisma.activityLog.create({
        data: {
          epcId: report.epcId,
          actorId: userId,
          action: "REPORT_CLARIFICATION_REQUESTED",
          metadata: { reason: String(reason).trim() },
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      message:
        "Clarification requested. The proposer has been notified to resubmit.",
    });
  } catch (error) {
    next(error);
  }
};

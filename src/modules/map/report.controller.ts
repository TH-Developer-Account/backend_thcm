import { Request, Response, NextFunction } from "express";
import multer from "multer";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  uploadReportImage,
  deleteReportImage,
  getSignedImageUrl,
  getSignedReportUrl,
} from "@shared/utils/aws-s3.services";
import { canManageApp } from "@kernel/rbac/userPermission";
import {
  getValidatorForApp,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
} from "@shared/utils/validators.constant";
import { eventReportGenerationQueue } from "@modules/map/eventReportGeneration.queue";
import {
  resolveEventReportTemplate,
  resolveEventReportFormConfig,
} from "./reports/eventReportTemplate.registry";
import { AuthenticatedUser } from "../../types/express";

// ─────────────────────────────────────────────────────────────────────────────
// Multer config — images arrive as a single "images" array field (1-10
// files), matched by index to a parallel "captions" JSON array.
// ─────────────────────────────────────────────────────────────────────────────

export const uploadReportImages = multer({
  storage: multer.memoryStorage(),
}).array("images", 10);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function resolveAppKeyForEpc(epcId: string): Promise<string> {
  const workflow = await prisma.workflowInstance.findFirst({
    where: { subjectType: "EVENT_PROPOSAL", subjectId: epcId, isActive: true },
    select: { template: { select: { app: { select: { key: true } } } } },
  });

  if (!workflow) {
    throw new ApiError(404, "No active workflow found for this EPC");
  }

  return workflow.template.app.key;
}

function assertValidImageFile(file: Express.Multer.File): void {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    throw new ApiError(400, "Only JPEG, PNG, and WebP images are accepted");
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new ApiError(400, "Each image must not exceed 5 MB");
  }
}

function parseCaptions(rawCaptions: unknown, expectedLength: number): string[] {
  let captions: unknown;
  try {
    captions = rawCaptions ? JSON.parse(String(rawCaptions)) : [];
  } catch {
    throw new ApiError(400, "captions must be a valid JSON array");
  }

  if (!Array.isArray(captions)) {
    throw new ApiError(400, "captions must be a JSON array of strings");
  }
  if (captions.length !== expectedLength) {
    throw new ApiError(
      400,
      `captions length (${captions.length}) must match images length (${expectedLength})`,
    );
  }

  return captions;
}

async function hydrateImageUrls(
  images: {
    id: string;
    position: number;
    caption: string | null;
    s3Key: string;
  }[],
): Promise<
  { id: string; position: number; caption: string | null; url: string }[]
> {
  const sorted = [...images].sort((a, b) => a.position - b.position);

  return Promise.all(
    sorted.map(async (img) => ({
      id: img.id,
      position: img.position,
      caption: img.caption,
      url: await getSignedImageUrl(img.s3Key),
    })),
  );
}

async function assertMachineStudyDataComplete(
  epcId: string,
  template: { reportTemplateKey: string },
): Promise<void> {
  const requiredVariants =
    template.reportTemplateKey === "FUEL_PRODUCTION_BENCHMARKING"
      ? [false, true]
      : [false];

  const studies = await prisma.machineStudy.findMany({
    where: {
      epcId,
      OR: requiredVariants.map((isCompetitorMachine) => ({
        isCompetitorMachine,
      })),
    },
    select: {
      id: true,
      isCompetitorMachine: true,
      _count: { select: { cycles: true } },
    },
  });

  const foundVariants = new Set(studies.map((s) => s.isCompetitorMachine));
  const missingVariant = requiredVariants.find((v) => !foundVariants.has(v));
  if (missingVariant !== undefined) {
    throw new ApiError(
      400,
      `Machine study data is missing${missingVariant ? " for the competitor machine" : ""}. Complete the Data Form before submitting the report.`,
    );
  }

  const missingCycles = studies.find((s) => s._count.cycles === 0);
  if (missingCycles) {
    throw new ApiError(
      400,
      "Cycle data has not been uploaded for this machine study. Upload it before submitting the report.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /report/form-config/:epcId
// ─────────────────────────────────────────────────────────────────────────────

export const getReportFormConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const epcId = String(req.params.epcId);
    const config = await resolveEventReportFormConfig(epcId);

    if (!config) {
      throw new ApiError(
        404,
        "No report template configured for this event type",
      );
    }

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:epcId/submit
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
    const files = (req.files as Express.Multer.File[]) ?? [];
    const { eventHighlights } = req.body;

    const captions = parseCaptions(req.body.captions, files.length);
    files.forEach(assertValidImageFile);

    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: {
        id: true,
        status: true,
        created_by_id: true,
        event_name_id: true,
      },
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

    const existing = await prisma.eventReport.findUnique({
      where: { epcId },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError(409, "A report already exists for this EPC");
    }

    const template = await resolveEventReportTemplate(epc.event_name_id);
    if (!template) {
      throw new ApiError(
        400,
        "This event type does not have a report template configured",
      );
    }

    if (
      files.length < template.minImages ||
      files.length > template.maxImages
    ) {
      throw new ApiError(
        400,
        `This event type requires between ${template.minImages} and ${template.maxImages} images — received ${files.length}`,
      );
    }

    if (template.sourceType === "DATA_FORM") {
      await assertMachineStudyDataComplete(epcId, template);
    }

    const appKey = await resolveAppKeyForEpc(epcId);
    const validatorId = getValidatorForApp(appKey);
    if (!validatorId) {
      throw new ApiError(500, `No validator configured for app "${appKey}"`);
    }

    const uploadResults = await Promise.all(
      files.map((file, index) =>
        uploadReportImage(epcId, index + 1, file.buffer, file.mimetype),
      ),
    );

    const report = await prisma.$transaction(async (tx) => {
      const created = await tx.eventReport.create({
        data: {
          epcId,
          status: "GENERATING",
          eventHighlights: eventHighlights?.trim() ?? null,
          validatorId,
          images: {
            create: uploadResults.map((result, index) => ({
              position: index + 1,
              caption: captions[index]?.trim() || null,
              s3Key: result.s3Key,
              fileUrl: result.fileUrl,
              mimeType: files[index].mimetype,
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
          subjectType: "EVENT_PROPOSAL",
          subjectId: epcId,
          actorId: userId,
          action: "REPORT_SUBMITTED",
        },
      });

      return created;
    });

    await eventReportGenerationQueue.add("generate", {
      reportId: report.id,
      epcId,
    });

    res.status(202).json({
      success: true,
      message: "Report submitted. Generation is in progress.",
      data: { reportId: report.id, status: report.status },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /report/:epcId/resubmit
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
    const files = (req.files as Express.Multer.File[]) ?? [];
    const { eventHighlights } = req.body;

    let positions: number[] = [];
    if (files.length > 0) {
      try {
        positions = req.body.positions ? JSON.parse(req.body.positions) : [];
      } catch {
        throw new ApiError(400, "positions must be a valid JSON array");
      }
      if (positions.length !== files.length) {
        throw new ApiError(
          400,
          `positions length (${positions.length}) must match images length (${files.length})`,
        );
      }
    }

    const captions =
      files.length > 0 ? parseCaptions(req.body.captions, files.length) : [];
    files.forEach(assertValidImageFile);

    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true, status: true, created_by_id: true },
    });
    if (!epc) throw new ApiError(404, "EPC not found");
    if (epc.created_by_id !== userId) {
      throw new ApiError(403, "Only the EPC creator can resubmit the report");
    }

    const existingReport = await prisma.eventReport.findUnique({
      where: { epcId },
      select: {
        id: true,
        status: true,
        images: { select: { id: true, position: true, s3Key: true } },
      },
    });
    if (!existingReport) throw new ApiError(404, "Report not found");

    // Resubmit is valid in two cases: the validator sent it back for
    // clarification (epc.status === CLARIFY_REPORT), or the previous
    // generation attempt failed and the proposer is retrying
    // (report.status === GENERATION_FAILED).
    const isClarificationResubmit = epc.status === "CLARIFY_REPORT";
    const isGenerationRetry = existingReport.status === "GENERATION_FAILED";

    if (!isClarificationResubmit && !isGenerationRetry) {
      throw new ApiError(
        400,
        "Report can only be resubmitted after clarification is requested, or retried after a failed generation",
      );
    }

    const existingPositions = new Set(
      existingReport.images.map((img) => img.position),
    );
    const unknownPosition = positions.find(
      (pos) => !existingPositions.has(pos),
    );
    if (unknownPosition !== undefined) {
      throw new ApiError(
        400,
        `Position ${unknownPosition} does not exist on this report. Resubmit only replaces existing images.`,
      );
    }

    const uploadResults = await Promise.all(
      files.map((file, index) =>
        uploadReportImage(epcId, positions[index], file.buffer, file.mimetype),
      ),
    );

    const existingImageMap = new Map(
      existingReport.images.map((img) => [img.position, img.s3Key]),
    );
    await Promise.allSettled(
      positions.map((pos) => {
        const oldKey = existingImageMap.get(pos);
        return oldKey ? deleteReportImage(oldKey) : Promise.resolve();
      }),
    );

    const report = await prisma.$transaction(async (tx) => {
      const updated = await tx.eventReport.update({
        where: { epcId },
        data: {
          status: "GENERATING",
          clarificationReason: null,
          generationError: null,
          resubmittedAt: new Date(),
          ...(eventHighlights !== undefined && {
            eventHighlights: eventHighlights?.trim() || null,
          }),
          images: {
            upsert: positions.map((pos, index) => ({
              where: {
                reportId_position: {
                  reportId: existingReport.id,
                  position: pos,
                },
              },
              create: {
                position: pos,
                caption: captions[index]?.trim() || null,
                s3Key: uploadResults[index].s3Key,
                fileUrl: uploadResults[index].fileUrl,
                mimeType: files[index].mimetype,
              },
              update: {
                caption: captions[index]?.trim() || null,
                s3Key: uploadResults[index].s3Key,
                fileUrl: uploadResults[index].fileUrl,
                mimeType: files[index].mimetype,
              },
            })),
          },
        },
        include: { images: true },
      });

      if (isClarificationResubmit) {
        await tx.eventProposal.update({
          where: { id: epcId },
          data: { status: "REPORT_SUBMITTED" },
        });
      }

      await tx.activityLog.create({
        data: {
          subjectType: "EVENT_PROPOSAL",
          subjectId: epcId,
          actorId: userId,
          action: "REPORT_RESUBMITTED",
        },
      });

      return updated;
    });

    await eventReportGenerationQueue.add("generate", {
      reportId: report.id,
      epcId,
    });

    res.status(202).json({
      success: true,
      message: "Report resubmitted. Generation is in progress.",
      data: { reportId: report.id, status: report.status },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /report/:epcId
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

    const { images, pdfS3Key, ...reportData } = report;
    const pdfUrl = pdfS3Key ? await getSignedReportUrl(pdfS3Key) : null;

    res.status(200).json({
      success: true,
      data: {
        ...reportData,
        pdfUrl,
        images: await hydrateImageUrls(images),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:reportId/validate
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
          subjectType: "EVENT_PROPOSAL",
          subjectId: report.epcId,
          actorId: userId,
          action: "REPORT_VALIDATED",
        },
      }),
    ]);

    res
      .status(200)
      .json({ success: true, message: "Report validated successfully" });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /report/:reportId/request-clarification
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
        `Clarification can only be requested on a SUBMITTED report. Current status: ${report.status}`,
      );
    }

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
          subjectType: "EVENT_PROPOSAL",
          subjectId: report.epcId,
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

export const getReportListing = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.id) throw new ApiError(401, "Unauthorized");

    const {
      page = "1",
      pageSize = "20",
      status,
      search,
      fromDate,
      toDate,
    } = req.query;

    const skip = (Number(page) - 1) * Number(pageSize);
    const take = Number(pageSize);

    const isAdmin = Boolean(user?.isSuperAdmin) || canManageApp(user, "MAP");

    const where: Record<string, any> = {};

    if (!isAdmin) {
      where.epc = { created_by_id: user?.id };
    }

    if (status) {
      const validStatuses = [
        "GENERATING",
        "GENERATION_FAILED",
        "SUBMITTED",
        "VALIDATED",
        "REJECTED",
        "CLARIFICATION_REQUESTED",
      ];
      if (!validStatuses.includes(status as string)) {
        throw new ApiError(
          400,
          `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        );
      }
      where.status = status;
    }

    if (fromDate || toDate) {
      where.submittedAt = {};
      if (fromDate) where.submittedAt.gte = new Date(fromDate as string);
      if (toDate) where.submittedAt.lte = new Date(toDate as string);
    }

    if (search) {
      const term = String(search).trim();
      where.AND = [
        {
          OR: [
            {
              epc: { proposal_number: { contains: term, mode: "insensitive" } },
            },
            {
              epc: {
                event_name: { title: { contains: term, mode: "insensitive" } },
              },
            },
          ],
        },
      ];
    }

    const [reports, total] = await Promise.all([
      prisma.eventReport.findMany({
        where,
        skip,
        take,
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          status: true,
          submittedAt: true,
          resubmittedAt: true,
          validatedAt: true,
          pdfS3Key: true,
          epc: {
            select: {
              id: true,
              proposal_number: true,
              location: true,
              event_name: { select: { title: true } },
              created_by: {
                select: { id: true, first_name: true, last_name: true },
              },
            },
          },
          validator: {
            select: { id: true, first_name: true, last_name: true },
          },
        },
      }),
      prisma.eventReport.count({ where }),
    ]);

    const data = reports.map(({ pdfS3Key, ...report }) => ({
      ...report,
      hasPdf: Boolean(pdfS3Key),
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: Number(page),
        pageSize: take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    next(error);
  }
};

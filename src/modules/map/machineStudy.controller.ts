import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import { importMachineStudyCyclesFromS3 } from "@import-export/machineStudyCycleImport.services";
import { FuelType } from "../../prisma/generated/prisma/client";

const ALLOWED_SPREADSHEET_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const MAX_SPREADSHEET_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

type MachineStudyPayload = {
  epcId: string;
  isCompetitorMachine?: boolean;
  machineModel: string;
  customerName: string;
  startDate: string;
  endDate: string;
  application: string;
  fuelType: FuelType;
  startHmr: number;
  endHmr: number;
  bucketVolumeCuM: number;
  acStatus: string;
  operationMode: string;
  dieselTopUpLtr?: number;
  startKwhReading?: number;
  endKwhReading?: number;
  operatorName?: string;
  operatorExperience?: string;
  priorMachinesOperated?: string;
};

function assertValidFuelTypeInputs(
  payload: Partial<MachineStudyPayload>,
): void {
  if (payload.fuelType === "DIESEL" && payload.dieselTopUpLtr === undefined) {
    throw new ApiError(
      400,
      "dieselTopUpLtr is required when fuelType is DIESEL",
    );
  }
  if (
    payload.fuelType === "ELECTRIC" &&
    (payload.startKwhReading === undefined ||
      payload.endKwhReading === undefined)
  ) {
    throw new ApiError(
      400,
      "startKwhReading and endKwhReading are required when fuelType is ELECTRIC",
    );
  }
}

function validateRequiredFields(payload: Partial<MachineStudyPayload>): void {
  const required: (keyof MachineStudyPayload)[] = [
    "epcId",
    "machineModel",
    "customerName",
    "startDate",
    "endDate",
    "application",
    "fuelType",
    "startHmr",
    "endHmr",
    "bucketVolumeCuM",
    "acStatus",
    "operationMode",
  ];

  const missing = required.filter(
    (field) => payload[field] === undefined || payload[field] === "",
  );
  if (missing.length > 0) {
    throw new ApiError(400, `Missing required field(s): ${missing.join(", ")}`);
  }

  if (!["DIESEL", "ELECTRIC"].includes(payload.fuelType as string)) {
    throw new ApiError(400, "fuelType must be DIESEL or ELECTRIC");
  }

  if (
    isNaN(Date.parse(payload.startDate as string)) ||
    isNaN(Date.parse(payload.endDate as string))
  ) {
    throw new ApiError(400, "startDate and endDate must be valid dates");
  }

  assertValidFuelTypeInputs(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /machine-studies
//
// Creates a MachineStudy header record for an EPC. For single-machine
// templates, omit isCompetitorMachine (defaults to false). For the
// benchmarking template, call this twice — once with isCompetitorMachine:
// false, once with true.
//
// Guards:
//   - EPC must exist
//   - At most one MachineStudy per (epcId, isCompetitorMachine) — enforced
//     by the DB unique constraint; a duplicate returns 409
// ─────────────────────────────────────────────────────────────────────────────

export const createMachineStudy = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const payload = req.body as MachineStudyPayload;
    validateRequiredFields(payload);

    const epc = await prisma.eventProposal.findUnique({
      where: { id: payload.epcId },
      select: { id: true },
    });
    if (!epc) throw new ApiError(404, "Event Proposal not found");

    const study = await prisma.machineStudy.create({
      data: {
        epcId: payload.epcId,
        isCompetitorMachine: payload.isCompetitorMachine ?? false,
        machineModel: payload.machineModel.trim(),
        customerName: payload.customerName.trim(),
        startDate: new Date(payload.startDate),
        endDate: new Date(payload.endDate),
        application: payload.application.trim(),
        fuelType: payload.fuelType,
        startHmr: payload.startHmr,
        endHmr: payload.endHmr,
        bucketVolumeCuM: payload.bucketVolumeCuM,
        acStatus: payload.acStatus.trim(),
        operationMode: payload.operationMode.trim(),
        dieselTopUpLtr: payload.dieselTopUpLtr ?? null,
        startKwhReading: payload.startKwhReading ?? null,
        endKwhReading: payload.endKwhReading ?? null,
        operatorName: payload.operatorName?.trim() ?? null,
        operatorExperience: payload.operatorExperience?.trim() ?? null,
        priorMachinesOperated: payload.priorMachinesOperated?.trim() ?? null,
      },
    });

    res.status(201).json({
      success: true,
      message: "Machine study created successfully",
      data: study,
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      return next(
        new ApiError(
          409,
          "A machine study already exists for this EPC and variant. Use the update endpoint instead.",
        ),
      );
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /machine-studies/:id — partial update, same validation as create for
// any field that's actually supplied.
// ─────────────────────────────────────────────────────────────────────────────

export const updateMachineStudy = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { id } = req.params;
    const payload = req.body as Partial<MachineStudyPayload>;

    if (
      payload.fuelType &&
      !["DIESEL", "ELECTRIC"].includes(payload.fuelType)
    ) {
      throw new ApiError(400, "fuelType must be DIESEL or ELECTRIC");
    }
    if (payload.startDate && isNaN(Date.parse(payload.startDate))) {
      throw new ApiError(400, "Invalid startDate");
    }
    if (payload.endDate && isNaN(Date.parse(payload.endDate))) {
      throw new ApiError(400, "Invalid endDate");
    }

    // Only re-validate fuel-type-conditional fields if fuelType itself is
    // being changed in this update — otherwise we'd force the caller to
    // resend dieselTopUpLtr on every unrelated field edit.
    if (payload.fuelType) {
      assertValidFuelTypeInputs(payload);
    }

    const data: Record<string, unknown> = {};
    if (payload.machineModel !== undefined)
      data.machineModel = payload.machineModel.trim();
    if (payload.customerName !== undefined)
      data.customerName = payload.customerName.trim();
    if (payload.startDate !== undefined)
      data.startDate = new Date(payload.startDate);
    if (payload.endDate !== undefined) data.endDate = new Date(payload.endDate);
    if (payload.application !== undefined)
      data.application = payload.application.trim();
    if (payload.fuelType !== undefined) data.fuelType = payload.fuelType;
    if (payload.startHmr !== undefined) data.startHmr = payload.startHmr;
    if (payload.endHmr !== undefined) data.endHmr = payload.endHmr;
    if (payload.bucketVolumeCuM !== undefined)
      data.bucketVolumeCuM = payload.bucketVolumeCuM;
    if (payload.acStatus !== undefined) data.acStatus = payload.acStatus.trim();
    if (payload.operationMode !== undefined)
      data.operationMode = payload.operationMode.trim();
    if (payload.dieselTopUpLtr !== undefined)
      data.dieselTopUpLtr = payload.dieselTopUpLtr;
    if (payload.startKwhReading !== undefined)
      data.startKwhReading = payload.startKwhReading;
    if (payload.endKwhReading !== undefined)
      data.endKwhReading = payload.endKwhReading;
    if (payload.operatorName !== undefined)
      data.operatorName = payload.operatorName?.trim() ?? null;
    if (payload.operatorExperience !== undefined)
      data.operatorExperience = payload.operatorExperience?.trim() ?? null;
    if (payload.priorMachinesOperated !== undefined)
      data.priorMachinesOperated =
        payload.priorMachinesOperated?.trim() ?? null;

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "No fields provided to update");
    }

    const updated = await prisma.machineStudy.update({
      where: { id: id as string },
      data,
    });

    res.status(200).json({
      success: true,
      message: "Machine study updated successfully",
      data: updated,
    });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Machine study not found"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /machine-studies/epc/:epcId — all studies for an EPC (1 or 2, depending
// on whether it's a benchmarking-template event).
// ─────────────────────────────────────────────────────────────────────────────

export const getMachineStudiesForEpc = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId } = req.params;
    const studies = await prisma.machineStudy.findMany({
      where: { epcId: epcId as string },
      include: { _count: { select: { cycles: true } } },
      orderBy: { isCompetitorMachine: "asc" },
    });

    res.status(200).json({ success: true, data: studies });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /machine-studies/:id — single study with its cycle rows.
// ─────────────────────────────────────────────────────────────────────────────

export const getMachineStudyById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { id } = req.params;

    const study = await prisma.machineStudy.findUnique({
      where: { id: id as string },
      include: { cycles: { orderBy: { sequenceNo: "asc" } } },
    });

    if (!study) throw new ApiError(404, "Machine study not found");

    res.status(200).json({ success: true, data: study });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /machine-studies/:id/cycles
//
// Uploads and imports the truck-by-truck cycle table for an existing study.
// Replaces any previously imported cycles for this study — re-uploading is
// treated as "this is the correct file now," not an append.
//
// Processed synchronously (small dataset — a single truck study, not a bulk
// lead list) — see note above the imports if this should be queued instead.
// ─────────────────────────────────────────────────────────────────────────────

export const uploadMachineStudyCycles = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { id } = req.params;
    const file = req.file as Express.Multer.File | undefined;

    if (!file) throw new ApiError(400, "A cycle-table file is required");
    if (!ALLOWED_SPREADSHEET_MIME_TYPES.has(file.mimetype)) {
      throw new ApiError(400, "Only CSV, XLS, and XLSX files are accepted");
    }
    if (file.size > MAX_SPREADSHEET_SIZE_BYTES) {
      throw new ApiError(400, "File must not exceed 5 MB");
    }

    const study = await prisma.machineStudy.findUnique({
      where: { id: id as string },
      select: { id: true },
    });
    if (!study) throw new ApiError(404, "Machine study not found");

    const s3Key = `machine-studies/${id}/cycles-${Date.now()}.xlsx`;
    await uploadToS3(s3Key, file.buffer, file.mimetype);

    // Re-upload replaces the existing cycle set for this study.
    await prisma.machineStudyCycle.deleteMany({
      where: { studyId: id as string },
    });

    const result = await importMachineStudyCyclesFromS3(
      id as string,
      s3Key,
      file.mimetype,
    );

    res.status(200).json({
      success: true,
      message: `${result.processedRows} cycle row(s) imported successfully`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

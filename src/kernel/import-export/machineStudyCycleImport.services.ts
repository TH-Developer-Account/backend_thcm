import { prisma } from "@shared/config/prisma";
import { parseFile, RawRow } from "@import-export/utils/fileParser";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";

const BATCH_SIZE = 500;
const LOADING_REMARK = "loading";

export type RowError = { row: number; field: string; message: string };

export type CycleImportResult = {
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: RowError[];
  allRawRows: RawRow[];
};

type ValidCycle = {
  studyId: string;
  sequenceNo: number;
  truckNumber: string | null;
  startSeconds: number;
  finishSeconds: number;
  timeTakenSeconds: number;
  bucketPasses: number | null;
  swingAngleDegrees: string | null;
  unladenWeightKg: number | null;
  ladenWeightKg: number | null;
  payloadKg: number | null;
  remarks: string | null;
};

// ── Explicit type guard — see leadImport.services.ts for why this is used
// instead of relying on `if (result.valid)` control-flow narrowing.
function isValidRow<TValid, TError>(
  result: ({ valid: true } & TValid) | ({ valid: false } & TError),
): result is { valid: true } & TValid {
  return result.valid === true;
}

function parseHhMmSsToSeconds(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseOptionalInt(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : Math.round(parsed);
}

function parseOptionalDecimal(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function validateRow(
  raw: RawRow,
  rowIndex: number,
  studyId: string,
): { valid: true; cycle: ValidCycle } | { valid: false; errors: RowError[] } {
  const errors: RowError[] = [];
  const displayRow = rowIndex + 2;

  const sl = parseOptionalInt(raw["sl"]);
  if (sl === null) {
    errors.push({
      row: displayRow,
      field: "sl",
      message: "Sl is required and must be a number",
    });
  }

  const startSeconds = parseHhMmSsToSeconds(raw["start (hh:mm:ss)"]);
  const finishSeconds = parseHhMmSsToSeconds(raw["finish (hh:mm:ss)"]);
  const timeTakenSeconds = parseHhMmSsToSeconds(raw["time taken (hh:mm:ss)"]);

  if (startSeconds === null) {
    errors.push({
      row: displayRow,
      field: "start (hh:mm:ss)",
      message: "invalid or missing time",
    });
  }
  if (finishSeconds === null) {
    errors.push({
      row: displayRow,
      field: "finish (hh:mm:ss)",
      message: "invalid or missing time",
    });
  }
  if (timeTakenSeconds === null) {
    errors.push({
      row: displayRow,
      field: "time taken (hh:mm:ss)",
      message: "invalid or missing time",
    });
  }

  const remarks = raw["remarks"]?.trim() || null;
  const isLoadingRow = remarks?.toLowerCase() === LOADING_REMARK;
  const truckNumber = raw["truck number"]?.trim() || null;

  if (isLoadingRow && !truckNumber) {
    errors.push({
      row: displayRow,
      field: "truck number",
      message: `required when remarks is "Loading"`,
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    cycle: {
      studyId,
      sequenceNo: sl as number,
      truckNumber,
      startSeconds: startSeconds as number,
      finishSeconds: finishSeconds as number,
      timeTakenSeconds: timeTakenSeconds as number,
      bucketPasses: parseOptionalInt(raw["bucket passes (no.)"]),
      swingAngleDegrees: raw["swing angle (degree)"]?.trim() || null,
      unladenWeightKg: parseOptionalDecimal(raw["unladened weight (kg)"]),
      ladenWeightKg: parseOptionalDecimal(raw["ladened weight (kg)"]),
      payloadKg: parseOptionalDecimal(raw["payload (kg)"]),
      remarks,
    },
  };
}

async function batchInsert(cycles: ValidCycle[]): Promise<void> {
  for (let i = 0; i < cycles.length; i += BATCH_SIZE) {
    await prisma.machineStudyCycle.createMany({
      data: cycles.slice(i, i + BATCH_SIZE),
    });
  }
}

export async function importMachineStudyCyclesFromS3(
  studyId: string,
  fileS3Key: string,
  fileMimeType: string,
): Promise<CycleImportResult> {
  const study = await prisma.machineStudy.findUnique({
    where: { id: studyId },
    select: { id: true },
  });
  if (!study) throw new Error(`MachineStudy not found: ${studyId}`);

  const fileBuffer = await downloadFromS3(fileS3Key);
  const { rows, totalRows } = parseFile(fileBuffer, fileMimeType);

  if (totalRows === 0) {
    return {
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
      errors: [],
      allRawRows: [],
    };
  }

  const validCycles: ValidCycle[] = [];
  const allErrors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i], i, studyId);

    if (isValidRow<{ cycle: ValidCycle }, { errors: RowError[] }>(result)) {
      validCycles.push(result.cycle);
    } else {
      allErrors.push(...result.errors);
    }
  }

  if (validCycles.length > 0) await batchInsert(validCycles);

  return {
    totalRows,
    processedRows: validCycles.length,
    failedRows: totalRows - validCycles.length,
    errors: allErrors,
    allRawRows: allErrors.length > 0 ? rows : [],
  };
}

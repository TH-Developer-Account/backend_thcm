import { prisma } from "@shared/config/prisma";
import { parseFile, RawRow } from "@import-export/utils/fileParser";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────────
// machineStudyCycleImport.service.ts
//
// Parses the truck-by-truck cycle table. Time Taken and Payload are no
// longer accepted as input columns — both are pure arithmetic on other
// columns already in the sheet (Finish-Start, Laden-Unladen), and taking
// them as manual input was exactly what caused the source data's own
// inconsistency (a stray "0" landing in either Bucket Passes or Payload on
// Material Preparation rows, depending on who filled it in). Computing
// them here removes that entire class of error rather than tolerating it.
//
// Remarks is now a controlled dropdown at the template level (Loading /
// Material Preparation only) — every downstream calculation (Loading Time,
// Tons/Hr, the benchmark comparison) depends on classifying rows correctly
// off this field, so it's validated strictly here rather than leniently
// matched, now that the template itself constrains what can be entered.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;
const VALID_REMARKS = new Set(["loading", "material preparation"]);
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
  remarks: string;
};

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
  if (
    startSeconds !== null &&
    finishSeconds !== null &&
    finishSeconds < startSeconds
  ) {
    errors.push({
      row: displayRow,
      field: "finish (hh:mm:ss)",
      message: "finish time cannot be before start time",
    });
  }

  const remarksRaw = raw["remarks"]?.trim() ?? "";
  const remarksNormalized = remarksRaw.toLowerCase();
  if (!VALID_REMARKS.has(remarksNormalized)) {
    errors.push({
      row: displayRow,
      field: "remarks",
      message: `remarks must be "Loading" or "Material Preparation", got "${remarksRaw}"`,
    });
  }
  const isLoadingRow = remarksNormalized === LOADING_REMARK;

  const truckNumber = raw["truck number"]?.trim() || null;
  if (isLoadingRow && !truckNumber) {
    errors.push({
      row: displayRow,
      field: "truck number",
      message: `required when remarks is "Loading"`,
    });
  }

  const unladenWeightKg = parseOptionalDecimal(raw["unladened weight (kg)"]);
  const ladenWeightKg = parseOptionalDecimal(raw["ladened weight (kg)"]);

  if (isLoadingRow && (unladenWeightKg === null || ladenWeightKg === null)) {
    errors.push({
      row: displayRow,
      field: "unladened weight (kg) / ladened weight (kg)",
      message: `both weights are required when remarks is "Loading"`,
    });
  }
  if (
    unladenWeightKg !== null &&
    ladenWeightKg !== null &&
    ladenWeightKg < unladenWeightKg
  ) {
    errors.push({
      row: displayRow,
      field: "ladened weight (kg)",
      message: "laden weight cannot be less than unladen weight",
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  const timeTakenSeconds = (finishSeconds as number) - (startSeconds as number);
  const payloadKg =
    unladenWeightKg !== null && ladenWeightKg !== null
      ? ladenWeightKg - unladenWeightKg
      : null;

  return {
    valid: true,
    cycle: {
      studyId,
      sequenceNo: sl as number,
      truckNumber,
      startSeconds: startSeconds as number,
      finishSeconds: finishSeconds as number,
      timeTakenSeconds,
      bucketPasses: parseOptionalInt(raw["bucket passes (no.)"]),
      swingAngleDegrees: raw["swing angle (degree)"]?.trim() || null,
      unladenWeightKg,
      ladenWeightKg,
      payloadKg,
      remarks:
        remarksNormalized === LOADING_REMARK
          ? "Loading"
          : "Material Preparation",
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

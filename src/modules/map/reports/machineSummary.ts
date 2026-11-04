const LOADING_REMARK = "loading";

export type MachineStudySummary = {
  loadingTimeSeconds: number;
  preparationTimeSeconds: number;
  totalTimeSeconds: number;
  totalBucketsLoaded: number;
  avgTimePerBucketSeconds: number | null;
  totalPayloadKg: number;
  ltrPerHr: number | null;
  tonsPerLtr: number | null;
  tonsPerHr: number | null;
  kwhPerHr: number | null;
  tonsPerKwh: number | null;
};

type MachineStudyInput = {
  fuelType: "DIESEL" | "ELECTRIC";
  dieselTopUpLtr: number | null;
  startKwhReading: number | null;
  endKwhReading: number | null;
};

type MachineStudyCycleInput = {
  timeTakenSeconds: number;
  bucketPasses: number | null;
  payloadKg: number | null;
  remarks: string | null;
};

export function computeMachineStudySummary(
  study: MachineStudyInput,
  cycles: MachineStudyCycleInput[],
): MachineStudySummary {
  let loadingTimeSeconds = 0;
  let preparationTimeSeconds = 0;
  let totalBucketsLoaded = 0;
  let totalPayloadKg = 0;

  for (const cycle of cycles) {
    const isLoading = cycle.remarks?.trim().toLowerCase() === LOADING_REMARK;
    if (isLoading) {
      loadingTimeSeconds += cycle.timeTakenSeconds;
      totalBucketsLoaded += cycle.bucketPasses ?? 0;
      totalPayloadKg += cycle.payloadKg ?? 0;
    } else {
      preparationTimeSeconds += cycle.timeTakenSeconds;
    }
  }

  const totalTimeSeconds = loadingTimeSeconds + preparationTimeSeconds;
  const totalTimeHours = totalTimeSeconds / 3600;
  const totalPayloadTons = totalPayloadKg / 1000;

  const avgTimePerBucketSeconds =
    totalBucketsLoaded > 0 ? loadingTimeSeconds / totalBucketsLoaded : null;

  let ltrPerHr: number | null = null;
  let tonsPerLtr: number | null = null;
  let tonsPerHr: number | null = null;
  let kwhPerHr: number | null = null;
  let tonsPerKwh: number | null = null;

  if (
    study.fuelType === "DIESEL" &&
    study.dieselTopUpLtr &&
    totalTimeHours > 0
  ) {
    ltrPerHr = study.dieselTopUpLtr / totalTimeHours;
    tonsPerLtr = totalPayloadTons / study.dieselTopUpLtr;
    tonsPerHr = totalPayloadTons / totalTimeHours;
  }

  if (
    study.fuelType === "ELECTRIC" &&
    study.startKwhReading != null &&
    study.endKwhReading != null &&
    totalTimeHours > 0
  ) {
    const powerConsumedKwh = study.endKwhReading - study.startKwhReading;
    kwhPerHr = powerConsumedKwh / totalTimeHours;
    tonsPerKwh =
      powerConsumedKwh > 0 ? totalPayloadTons / powerConsumedKwh : null;
    tonsPerHr = totalPayloadTons / totalTimeHours;
  }

  return {
    loadingTimeSeconds,
    preparationTimeSeconds,
    totalTimeSeconds,
    totalBucketsLoaded,
    avgTimePerBucketSeconds,
    totalPayloadKg,
    ltrPerHr,
    tonsPerLtr,
    tonsPerHr,
    kwhPerHr,
    tonsPerKwh,
  };
}

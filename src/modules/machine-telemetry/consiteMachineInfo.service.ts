// ─────────────────────────────────────────────────────────────────────────────
// Fetches every machine ConSite knows about, in bulk, paginated.
//
// Common_Machine_Info_Search returns up to `maxNum` machines per call,
// starting at `start`, and tells us via nextFlg whether more remain. This
// collapses what used to be one HTTP call per machine (the old C4C sync —
// ~11,100 calls a night) into a handful of large calls. That collapse is
// the actual "less load on the servers" lever for this whole migration —
// see machineTelemetryConSiteSync.service.ts for how the result is used.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import ApiError from "@shared/utils/apiError";
import { getConSiteAccessToken } from "./consiteAuth.service";
import { withRetry } from "./utils/withRetry";

// Matches the maxNum seen in the sample call. One page covers the current
// fleet size comfortably; the pagination loop below still walks `nextFlg`
// properly, so this only needs raising if the fleet grows well past it —
// it is not load-bearing for correctness.
const PAGE_SIZE = 30000;

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// Trimmed to the fields this codebase actually reads (pin/lat/lon/
// operationTm) plus an index signature for the rest — ConSite returns a
// number of other display-only fields (address, businessType*, modelNm,
// etc.) that nothing here stores, same "don't type what we don't use"
// convention as the old C4C sync's C4C_SELECT_FIELDS.
export type ConSiteMachineRecord = {
  pin: string;
  serialNo: string;
  lat: number;
  lon: number;
  operationTm: number;
  operationTmDate: string;
  lastPositionDate: string;
  [key: string]: unknown;
};

type ConSiteMachineInfoResponse = {
  result: string;
  value: {
    nextFlg: boolean;
    machineList: ConSiteMachineRecord[];
  };
};

function readConSiteApiBaseUrl(): string {
  const url = process.env.CONSITE_API_BASE_URL;
  if (!url) {
    throw new ApiError(500, "CONSITE_API_BASE_URL must be configured");
  }
  return url;
}

async function fetchMachineInfoPage(
  start: number,
): Promise<ConSiteMachineInfoResponse> {
  const accessToken = await getConSiteAccessToken();

  const { data } = await axios.get<ConSiteMachineInfoResponse>(
    `${readConSiteApiBaseUrl()}/Common_Machine_Info_Search`,
    {
      params: { maxNum: PAGE_SIZE, start },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  return data;
}

// Fetches every page until ConSite reports nextFlg: false. Re-resolves the
// access token on every page via getConSiteAccessToken() rather than once
// up front — that's a cheap Redis read in the common case, and it means a
// token that expires mid-pagination is transparently refreshed instead of
// failing the whole run partway through.
export async function fetchAllConSiteMachines(): Promise<
  ConSiteMachineRecord[]
> {
  const allMachines: ConSiteMachineRecord[] = [];
  let start = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await withRetry(() => fetchMachineInfoPage(start), {
      attempts: RETRY_ATTEMPTS,
      delayMs: RETRY_DELAY_MS,
    });

    const machines = page.value?.machineList ?? [];
    allMachines.push(...machines);

    // Safety net against an infinite loop if ConSite ever returns
    // nextFlg: true alongside an empty page.
    if (!page.value?.nextFlg || machines.length === 0) break;

    start += machines.length;
  }

  return allMachines;
}

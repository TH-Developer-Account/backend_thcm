import axios from "axios";

import ApiError from "./apiError";

type ODataCredentials = { username: string; password: string };

// One USERNAME / PASSWORD pair per SAP system, e.g. SAP_BYD_USERNAME and
// SAP_BYD_PASSWORD, so credentials never live in source control.
function readODataCredentials(environmentPrefix: string): ODataCredentials {
  const username = process.env[`${environmentPrefix}_USERNAME`];
  const password = process.env[`${environmentPrefix}_PASSWORD`];

  if (!username || !password) {
    throw new ApiError(
      500,
      `${environmentPrefix}_USERNAME and ${environmentPrefix}_PASSWORD must be configured`,
    );
  }
  return { username, password };
}

export async function fetchOData(
  url: string,
  environmentPrefix: string,
): Promise<unknown> {
  const response = await axios.get(url, {
    auth: readODataCredentials(environmentPrefix),
    headers: { Accept: "application/json" },
  });
  return response.data;
}

// SAP OData v2 wraps collections as { d: { results: [...] } }.
export function unwrapODataResults(data: unknown): unknown {
  const wrapped = data as { d?: { results?: unknown } } | null;
  return wrapped?.d?.results ?? data;
}

// Generic OData v2 pager: follows $skip until a page returns fewer than
// `pageSize` rows. The C4C/ConSite telemetry calls never needed this (one
// machine, or one already-paginated bulk endpoint), but GR/Invoice pull a
// date range that can span thousands of rows, so this is the one new
// piece of reusable fetch infrastructure (added for machine-billing sync).
export async function fetchAllODataPages<T>(
  buildPageUrl: (skip: number, top: number) => string,
  environmentPrefix: string,
  pageSize = 1000,
): Promise<T[]> {
  const allRows: T[] = [];
  let skip = 0;

  while (true) {
    const data = await fetchOData(
      buildPageUrl(skip, pageSize),
      environmentPrefix,
    );
    const page = (unwrapODataResults(data) as T[] | undefined) ?? [];
    allRows.push(...page);

    if (page.length < pageSize) break;
    skip += pageSize;
  }

  return allRows;
}

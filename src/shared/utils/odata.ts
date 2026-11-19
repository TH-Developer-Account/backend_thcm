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

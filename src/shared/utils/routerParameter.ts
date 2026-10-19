import type { Request } from "express";

import ApiError from "./apiError";

// Express 5 types every route parameter as string | string[] (wildcards can
// repeat), so single-value parameters are narrowed here once.
export function getRouteParameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, `Route parameter "${name}" is required`);
  }
  return value.trim();
}

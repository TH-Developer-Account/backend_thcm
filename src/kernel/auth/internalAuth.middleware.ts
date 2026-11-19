/**
 * middleware/internal-auth.js
 *
 * Guards internal/external service-to-service routes against a single
 * x-api-key header, checked against a caller-specific env var. One factory,
 * not one middleware per caller — each caller gets its own key (and can be
 * rotated independently) without duplicating the check itself.
 */
import { Request, Response, NextFunction } from "express";
import logger from "@shared/utils/logger";

export function createApiKeyAuth(envVarName: string) {
  return function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
    const key = req.headers["x-api-key"];
    const expected = process.env[envVarName];

    if (!expected) {
      // Fail closed: an unset env var must never silently accept any key.
      logger.error(`[apiKeyAuth] ${envVarName} is not configured`);
      return res.status(500).json({ error: "Server misconfigured" });
    }

    if (!key || key !== expected) {
      logger.warn("Unauthorized internal request rejected", {
        ip: req.ip,
        path: req.path,
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
}

// Existing call sites (operator.routes.ts, leads.routes.ts) import this name
// and expect a ready-to-use middleware, not a factory — kept as-is so
// nothing else needs to change.
export const internalAuth = createApiKeyAuth("WHATSAPP_BOT_API_KEY");

// Shopify/THCM's tracking callback — its own key, since this is a real
// external third party, not an internal MAP service sharing the bot key.
export const shopifyAuth = createApiKeyAuth("SHOPIFY_TRACKING_API_KEY");

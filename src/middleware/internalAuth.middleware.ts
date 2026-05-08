/**
 * middleware/internal-auth.js
 *
 * Guards internal service-to-service routes.
 * Rejects any request that does not carry the correct x-api-key header.
 */
import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

export function internalAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"];

  if (!key || key !== process.env.WHATSAPP_BOT_API_KEY) {
    logger.warn("Unauthorized internal request rejected", {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

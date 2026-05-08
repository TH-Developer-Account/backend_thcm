/**
 * controllers/operator.controller.js
 *
 * Validates the incoming payload and persists the operator.
 * Returns a clean JSON response — no internals leaked.
 */
import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import logger from "../config/logger";

// Fields the bot is allowed to send — anything else is ignored
const REQUIRED_FIELDS = ["name", "phone", "machine", "submittedBy"];

export async function registerOperator(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const body = req.body;

  // ── Validate ────────────────────────────────────────────────────────────
  const missing = REQUIRED_FIELDS.filter((f) => !body[f]);
  if (missing.length > 0) {
    logger.warn("Operator registration rejected — missing fields", { missing });
    res.status(400).json({
      error: "Missing required fields",
      fields: missing,
    });
    return;
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  try {
    const operator = await prisma.operator.create({
      data: {
        name: body.name,
        phone: body.phone,
        machineSerial: body.machine,
        submittedBy: body.submittedBy,
      },
    });

    logger.info("Operator registered", { operatorId: operator.id });

    res.status(201).json({
      success: true,
      operatorId: operator.id,
    });
  } catch (err) {
    next(err);
  }
}

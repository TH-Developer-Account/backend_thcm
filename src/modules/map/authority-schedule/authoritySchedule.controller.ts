// modules/admin/authority-schedule/authoritySchedule.controller.ts
//
// Admin CRUD for the Schedule of Authority (SOA) — the AuthorityLimit bands
// and their AuthorityLimitAssignment (designation x role) mappings that
// gate MAP's EPC auto-approve (see modules/map/authorityLimit.helper.ts and
// epc.controller.ts's finalizeEventProposal). Kept under modules/admin
// alongside Masters rather than inside modules/map — same SRP reasoning
// that already kept AuthorityLimit off the Designation table: this is
// MAP-only admin policy, not MAP's own domain logic.

import { Request, Response, NextFunction } from "express";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { AuthorityRole, Prisma } from "../../../prisma/generated/prisma/client";

const VALID_ROLES = new Set<AuthorityRole>([
  AuthorityRole.PROPOSER,
  AuthorityRole.CHECKER,
  AuthorityRole.APPROVER,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared select shape — every read returns bands with their assignments
// flattened to {designationId, designationName, role}, so the admin screen
// never has to stitch two responses together.
// ─────────────────────────────────────────────────────────────────────────────

const authorityLimitWithAssignmentsSelect = {
  id: true,
  label: true,
  minAmount: true,
  maxAmount: true,
  isActive: true,
  assignments: {
    select: {
      id: true,
      role: true,
      designationId: true,
      designation: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.AuthorityLimitSelect;

type AuthorityLimitWithAssignments = Prisma.AuthorityLimitGetPayload<{
  select: typeof authorityLimitWithAssignmentsSelect;
}>;

const serializeLimit = (limit: AuthorityLimitWithAssignments) => ({
  id: limit.id,
  label: limit.label,
  minAmount: limit.minAmount.toNumber(),
  maxAmount: limit.maxAmount ? limit.maxAmount.toNumber() : null,
  isActive: limit.isActive,
  assignments: limit.assignments.map((a) => ({
    id: a.id,
    role: a.role,
    designationId: a.designationId,
    designationName: a.designation.name,
  })),
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNoOverlap
//
// KISS overlap guard: a new/edited band's [minAmount, maxAmount) range must
// not overlap any OTHER active band. Not a DB constraint (see schema.prisma's
// note on AuthorityLimit) — enforced here, the one place bands are written.
// ─────────────────────────────────────────────────────────────────────────────

async function assertNoOverlap(
  minAmount: number,
  maxAmount: number | null,
  excludeId?: string,
) {
  if (maxAmount !== null && maxAmount <= minAmount) {
    throw new ApiError(400, "maxAmount must be greater than minAmount");
  }

  const others = await prisma.authorityLimit.findMany({
    where: {
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { minAmount: true, maxAmount: true },
  });

  const thisMax = maxAmount === null ? Infinity : maxAmount;

  const overlaps = others.some((other) => {
    const otherMin = other.minAmount.toNumber();
    const otherMax = other.maxAmount ? other.maxAmount.toNumber() : Infinity;

    return minAmount < otherMax && thisMax > otherMin;
  });

  if (overlaps) {
    throw new ApiError(
      400,
      "This range overlaps an existing active Schedule of Authority band.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /authority-schedule/limits
// ─────────────────────────────────────────────────────────────────────────────

export const listAuthorityLimits = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const limits = await prisma.authorityLimit.findMany({
      orderBy: { minAmount: "asc" },
      select: authorityLimitWithAssignmentsSelect,
    });

    res.status(200).json({ success: true, data: limits.map(serializeLimit) });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /authority-schedule/limits
// ─────────────────────────────────────────────────────────────────────────────

export const createAuthorityLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { label, minAmount, maxAmount, isActive } = req.body as {
      label?: string;
      minAmount?: number;
      maxAmount?: number | null;
      isActive?: boolean;
    };

    if (!label?.trim()) throw new ApiError(400, "label is required");
    if (
      minAmount === undefined ||
      minAmount === null ||
      isNaN(Number(minAmount))
    ) {
      throw new ApiError(400, "minAmount is required and must be a number");
    }

    const normalizedMax =
      maxAmount === undefined || maxAmount === null ? null : Number(maxAmount);

    await assertNoOverlap(Number(minAmount), normalizedMax);

    const created = await prisma.authorityLimit.create({
      data: {
        label: label.trim(),
        minAmount: Number(minAmount),
        maxAmount: normalizedMax,
        isActive: isActive ?? true,
      },
      select: authorityLimitWithAssignmentsSelect,
    });

    res.status(201).json({ success: true, data: serializeLimit(created) });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /authority-schedule/limits/:id
// ─────────────────────────────────────────────────────────────────────────────

export const updateAuthorityLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { label, minAmount, maxAmount, isActive } = req.body as {
      label?: string;
      minAmount?: number;
      maxAmount?: number | null;
      isActive?: boolean;
    };

    const existing = await prisma.authorityLimit.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "Authority limit band not found");

    const nextMin =
      minAmount === undefined
        ? existing.minAmount.toNumber()
        : Number(minAmount);
    const nextMax =
      maxAmount === undefined
        ? existing.maxAmount
          ? existing.maxAmount.toNumber()
          : null
        : maxAmount === null
          ? null
          : Number(maxAmount);
    const nextIsActive = isActive === undefined ? existing.isActive : isActive;

    if (nextIsActive) {
      await assertNoOverlap(nextMin, nextMax, id);
    }

    const updated = await prisma.authorityLimit.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label: label.trim() } : {}),
        minAmount: nextMin,
        maxAmount: nextMax,
        isActive: nextIsActive,
      },
      select: authorityLimitWithAssignmentsSelect,
    });

    res.status(200).json({ success: true, data: serializeLimit(updated) });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /authority-schedule/limits/:id/assignments
//
// Replaces the FULL assignment set for one band in a single call — matches
// how the admin screen's matrix works: it collects every selected
// designation x role pair for this band and submits once on Save, rather
// than issuing one request per checkbox/select toggle.
// ─────────────────────────────────────────────────────────────────────────────

export const replaceAuthorityLimitAssignments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { assignments } = req.body as {
      assignments?: Array<{ designationId: string; role: AuthorityRole }>;
    };

    const limit = await prisma.authorityLimit.findUnique({ where: { id } });
    if (!limit) throw new ApiError(404, "Authority limit band not found");

    if (!Array.isArray(assignments)) {
      throw new ApiError(400, "assignments must be an array");
    }

    for (const assignment of assignments) {
      if (!assignment?.designationId || !VALID_ROLES.has(assignment.role)) {
        throw new ApiError(
          400,
          `Invalid assignment: ${JSON.stringify(assignment)}`,
        );
      }
    }

    // De-duplicate (designationId, role) pairs — the UNIQUE constraint
    // would reject a duplicate anyway, but failing the whole request on
    // a client-side double-add is unnecessary friction.
    const unique = new Map(
      assignments.map((a) => [`${a.designationId}:${a.role}`, a]),
    );

    await prisma.$transaction([
      prisma.authorityLimitAssignment.deleteMany({
        where: { authorityLimitId: id },
      }),
      ...(unique.size
        ? [
            prisma.authorityLimitAssignment.createMany({
              data: [...unique.values()].map((a) => ({
                authorityLimitId: id,
                designationId: a.designationId,
                role: a.role,
              })),
            }),
          ]
        : []),
    ]);

    const updated = await prisma.authorityLimit.findUnique({
      where: { id },
      select: authorityLimitWithAssignmentsSelect,
    });

    res.status(200).json({ success: true, data: serializeLimit(updated!) });
  } catch (error) {
    next(error);
  }
};

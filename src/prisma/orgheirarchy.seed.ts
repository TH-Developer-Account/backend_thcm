import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// orgHierarchy.service.ts  —  v3
//
// Three responsibilities (same as v2, updated scoping logic):
//   1. Closure table maintenance   (insertClosureRowsForNewUnit) — unchanged
//   2. Subtree user resolution     (getSubtreeUserIds)           — unchanged
//   3. Scoping filter resolution   (getEpcScopingFilter)         — v3: adds dept
//
// Scoping filter logic by designation:
//
//   HEAD       → {}
//   DEPT_HEAD  → { department_id }
//   ZONAL_HEAD → { department_id, region_id }
//   AREA_HEAD  → { department_id, region_id }
//   MEMBER     → {} (already self-scoped by subtreeIds)
//
// Usage in EPC controller (unchanged from v2):
//
//   const [subtreeUserIds, scopingFilter] = await Promise.all([
//     getSubtreeUserIds(userId),
//     getEpcScopingFilter(userId),
//   ]);
//
//   prisma.eventProposal.findMany({
//     where: {
//       created_by_id: { in: subtreeUserIds },
//       ...scopingFilter,
//     }
//   })
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

// All possible shapes returned by getEpcScopingFilter.
// Spread directly into a Prisma where clause — empty object adds nothing.
export type EpcScopingFilter =
  | Record<string, never> // HEAD — no filters
  | { department_id: string } // DEPT_HEAD
  | { department_id: string; region_id: string }; // ZONAL_HEAD / AREA_HEAD

// ─────────────────────────────────────────────────────────────────────────────
// CLOSURE TABLE MAINTENANCE  (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a new OrgUnit is created.
 * Must be called inside the same transaction that creates the OrgUnit record.
 */
export async function insertClosureRowsForNewUnit(
  unitId: string,
  parentId: string | null,
): Promise<void> {
  const rowsToInsert: {
    ancestorId: string;
    descendantId: string;
    depth: number;
  }[] = [{ ancestorId: unitId, descendantId: unitId, depth: 0 }];

  if (parentId !== null) {
    const parentAncestors = await prisma.orgUnitClosure.findMany({
      where: { descendantId: parentId },
      select: { ancestorId: true, depth: true },
    });

    if (parentAncestors.length === 0) {
      throw new ApiError(
        500,
        `Parent unit ${parentId} has no closure rows — data integrity issue`,
      );
    }

    for (const { ancestorId, depth } of parentAncestors) {
      rowsToInsert.push({ ancestorId, descendantId: unitId, depth: depth + 1 });
    }
  }

  await prisma.orgUnitClosure.createMany({ data: rowsToInsert });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBTREE USER RESOLUTION  (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all userIds visible to the given user based purely on the org tree.
 * Always includes the user themselves.
 * Zone-agnostic and department-agnostic — answers "WHO" only.
 */
export async function getSubtreeUserIds(userId: string): Promise<string[]> {
  const managedUnits = await prisma.orgUnitMember.findMany({
    where: { userId, role: "MANAGER" },
    select: { orgUnitId: true },
  });

  if (managedUnits.length === 0) return [userId];

  const managedUnitIds = managedUnits.map((m) => m.orgUnitId);

  const descendantRows = await prisma.orgUnitClosure.findMany({
    where: { ancestorId: { in: managedUnitIds } },
    select: { descendantId: true },
  });

  const descendantUnitIds = [
    ...new Set(descendantRows.map((r) => r.descendantId)),
  ];

  const members = await prisma.orgUnitMember.findMany({
    where: { orgUnitId: { in: descendantUnitIds } },
    select: { userId: true },
  });

  const userIds = new Set(members.map((m) => m.userId));
  userIds.add(userId);
  return [...userIds];
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPING FILTER RESOLUTION  (v3 — adds department awareness)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Prisma where-clause fragment that enforces department and zone
 * restrictions based on the requesting user's designation level.
 *
 * Priority order when a user manages multiple units (least restrictive wins):
 *   HEAD > DEPT_HEAD > ZONAL_HEAD > AREA_HEAD
 *
 * Designation rules:
 *
 *   HEAD
 *     → returns {}
 *     → MD / VP — sees ALL EPCs across all departments and all zones
 *
 *   DEPT_HEAD
 *     → returns { department_id }
 *     → Marketing Head / Sales Head — sees all zones within their department
 *     → if their unit has no departmentId: falls back to {} with warning
 *
 *   ZONAL_HEAD
 *     → returns { department_id, region_id }
 *     → Zonal Head — sees only their dept AND their zone
 *     → if missing either ID: falls back gracefully with warning
 *
 *   AREA_HEAD
 *     → returns { department_id, region_id }
 *     → same mechanism as ZONAL_HEAD
 *
 *   MEMBER (or no managed units)
 *     → returns {}
 *     → already scoped to self via subtreeUserIds
 */
export async function getEpcScopingFilter(
  userId: string,
): Promise<EpcScopingFilter> {
  const managedMemberships = await prisma.orgUnitMember.findMany({
    where: { userId, role: "MANAGER" },
    select: {
      designationLevel: true,
      orgUnit: {
        select: {
          departmentId: true,
          regionId: true,
        },
      },
    },
  });

  // Not a manager anywhere — MEMBER, subtreeIds already scopes to self
  if (managedMemberships.length === 0) return {};

  // ── HEAD: company-wide, no filters ────────────────────────────────────────
  const isHead = managedMemberships.some((m) => m.designationLevel === "HEAD");
  if (isHead) return {};

  // ── DEPT_HEAD: department filter only, no zone filter ─────────────────────
  const deptHeadMembership = managedMemberships.find(
    (m) => m.designationLevel === "DEPT_HEAD",
  );
  if (deptHeadMembership) {
    if (!deptHeadMembership.orgUnit.departmentId) {
      console.warn(
        `[orgHierarchy] User ${userId} is DEPT_HEAD but unit has no departmentId. ` +
          "Falling back to no filter. Assign a department to the unit.",
      );
      return {};
    }
    return { department_id: deptHeadMembership.orgUnit.departmentId };
  }

  // ── ZONAL_HEAD: department + zone filter ───────────────────────────────────
  const zonalMembership = managedMemberships.find(
    (m) => m.designationLevel === "ZONAL_HEAD",
  );
  if (zonalMembership) {
    const { departmentId, regionId } = zonalMembership.orgUnit;
    if (!departmentId || !regionId) {
      console.warn(
        `[orgHierarchy] User ${userId} is ZONAL_HEAD but unit is missing ` +
          `departmentId=${departmentId} or regionId=${regionId}. ` +
          "Falling back to department filter only.",
      );
      return departmentId ? { department_id: departmentId } : {};
    }
    return { department_id: departmentId, region_id: regionId };
  }

  // ── AREA_HEAD: same filter mechanism as ZONAL_HEAD ────────────────────────
  const areaMembership = managedMemberships.find(
    (m) => m.designationLevel === "AREA_HEAD",
  );
  if (areaMembership) {
    const { departmentId, regionId } = areaMembership.orgUnit;
    if (!departmentId || !regionId) {
      console.warn(
        `[orgHierarchy] User ${userId} is AREA_HEAD but unit is missing ` +
          `departmentId=${departmentId} or regionId=${regionId}. ` +
          "Falling back to department filter only.",
      );
      return departmentId ? { department_id: departmentId } : {};
    }
    return { department_id: departmentId, region_id: regionId };
  }

  // All memberships are MEMBER designation
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGER GUARD  (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

export async function assertIsManagerOfUnit(
  userId: string,
  orgUnitId: string,
): Promise<void> {
  const membership = await prisma.orgUnitMember.findUnique({
    where: { orgUnitId_userId: { orgUnitId, userId } },
    select: { role: true },
  });

  if (!membership || membership.role !== "MANAGER") {
    throw new ApiError(403, "You are not a manager of this org unit");
  }
}

export async function getManagedUnitIds(userId: string): Promise<string[]> {
  const rows = await prisma.orgUnitMember.findMany({
    where: { userId, role: "MANAGER" },
    select: { orgUnitId: true },
  });
  return rows.map((r) => r.orgUnitId);
}

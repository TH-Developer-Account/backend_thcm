import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// orgHierarchy.service.ts  —  v4
//
// Four responsibilities:
//   1. Closure table maintenance  (insertClosureRowsForNewUnit) — unchanged
//   2. Subtree user resolution    (getSubtreeUserIds)           — unchanged
//   3. Scoping filter resolution  (getEpcScopingFilter)         — unchanged
//   4. Peer-to-peer resolution    (isPeerToPeerEnabled)         — NEW
//                                 (getPeerUserIds)              — NEW
//
// How everything composes in the EPC controller:
//
//   const [subtreeUserIds, scopingFilter, p2pEnabled] = await Promise.all([
//     getSubtreeUserIds(userId),
//     getEpcScopingFilter(userId),
//     isPeerToPeerEnabled(workspaceId),
//   ]);
//
//   const peerUserIds = p2pEnabled
//     ? await getPeerUserIds(userId)
//     : [];
//
//   where: {
//     OR: [
//       // Slice 1 — own EPCs + subordinates with dept/zone filter
//       { created_by_id: { in: subtreeUserIds }, ...scopingFilter },
//       // Slice 2 — peers (same designation, same dept, any zone)
//       ...(peerUserIds.length > 0
//         ? [{ created_by_id: { in: peerUserIds } }]
//         : []),
//     ],
//   }
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type EpcScopingFilter =
  | Record<string, never>
  | { department_id: string }
  | { department_id: string; region_id: string };

// Designations that participate in peer-to-peer.
// HEAD  → bypassed (sees everything already).
// MEMBER → excluded (would expose too many records to individual contributors).
const PEER_ELIGIBLE_DESIGNATIONS = [
  "DEPT_HEAD",
  "ZONAL_HEAD",
  "AREA_HEAD",
] as const;
type PeerEligibleDesignation = (typeof PEER_ELIGIBLE_DESIGNATIONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// CLOSURE TABLE MAINTENANCE  (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

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
// SCOPING FILTER RESOLUTION  (unchanged from v3)
// ─────────────────────────────────────────────────────────────────────────────

export async function getEpcScopingFilter(
  userId: string,
): Promise<EpcScopingFilter> {
  const managedMemberships = await prisma.orgUnitMember.findMany({
    where: { userId, role: "MANAGER" },
    select: {
      designationLevel: true,
      orgUnit: {
        select: { departmentId: true, regionId: true },
      },
    },
  });

  if (managedMemberships.length === 0) return {};

  const isHead = managedMemberships.some((m) => m.designationLevel === "HEAD");
  if (isHead) return {};

  const deptHead = managedMemberships.find(
    (m) => m.designationLevel === "DEPT_HEAD",
  );
  if (deptHead) {
    if (!deptHead.orgUnit.departmentId) {
      console.warn(
        `[orgHierarchy] User ${userId} is DEPT_HEAD but unit has no departmentId.`,
      );
      return {};
    }
    return { department_id: deptHead.orgUnit.departmentId };
  }

  const zonal = managedMemberships.find(
    (m) => m.designationLevel === "ZONAL_HEAD",
  );
  if (zonal) {
    const { departmentId, regionId } = zonal.orgUnit;
    if (!departmentId || !regionId) {
      console.warn(
        `[orgHierarchy] User ${userId} is ZONAL_HEAD but unit is missing departmentId or regionId.`,
      );
      return departmentId ? { department_id: departmentId } : {};
    }
    return { department_id: departmentId, region_id: regionId };
  }

  const area = managedMemberships.find(
    (m) => m.designationLevel === "AREA_HEAD",
  );
  if (area) {
    const { departmentId, regionId } = area.orgUnit;
    if (!departmentId || !regionId) {
      console.warn(
        `[orgHierarchy] User ${userId} is AREA_HEAD but unit is missing departmentId or regionId.`,
      );
      return departmentId ? { department_id: departmentId } : {};
    }
    return { department_id: departmentId, region_id: regionId };
  }

  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// PEER-TO-PEER — NEW in v4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if peer-to-peer visibility is enabled for the workspace.
 * Single indexed read on WorkspaceSettings. Cached at the call site
 * via Promise.all — not cached between requests (stateless service).
 */
export async function isPeerToPeerEnabled(
  workspaceId: string,
): Promise<boolean> {
  const settings = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { peerToPeerEnabled: true },
  });
  // If no settings row exists yet, default to false (safe)
  return settings?.peerToPeerEnabled ?? false;
}

/**
 * Returns userIds of all peers of the given user.
 *
 * Peer definition:
 *   Same designationLevel (DEPT_HEAD | ZONAL_HEAD | AREA_HEAD)
 *   AND same departmentId on their OrgUnit
 *   AND role = MANAGER (MEMBER designation excluded)
 *   AND NOT the user themselves
 *
 * HEAD designation → returns [] (bypassed — they already see everything)
 * MEMBER designation → returns [] (excluded — too broad)
 *
 * Zone filter does NOT apply to peers — a Marketing Zonal Head South
 * sees Marketing Zonal Head North's EPCs without zone restriction.
 * This is the intentional relaxation of the zone filter for peers.
 */
export async function getPeerUserIds(userId: string): Promise<string[]> {
  // Find the user's own managed memberships
  const ownMemberships = await prisma.orgUnitMember.findMany({
    where: { userId, role: "MANAGER" },
    select: {
      designationLevel: true,
      orgUnit: { select: { departmentId: true } },
    },
  });

  if (ownMemberships.length === 0) return [];

  // HEAD bypasses peer-to-peer — they already see all EPCs
  const isHead = ownMemberships.some((m) => m.designationLevel === "HEAD");
  if (isHead) return [];

  // Collect all peer-eligible (designation, departmentId) pairs this user holds
  type PeerKey = {
    designationLevel: PeerEligibleDesignation;
    departmentId: string;
  };
  const peerKeys: PeerKey[] = [];

  for (const m of ownMemberships) {
    if (
      !PEER_ELIGIBLE_DESIGNATIONS.includes(
        m.designationLevel as PeerEligibleDesignation,
      )
    )
      continue;
    if (!m.orgUnit.departmentId) continue; // company-wide unit — no dept peers
    peerKeys.push({
      designationLevel: m.designationLevel as PeerEligibleDesignation,
      departmentId: m.orgUnit.departmentId,
    });
  }

  if (peerKeys.length === 0) return [];

  // For each (designation, department) pair, find all other managers
  // with the same designation in the same department
  const peerUserIds = new Set<string>();

  for (const { designationLevel, departmentId } of peerKeys) {
    const peers = await prisma.orgUnitMember.findMany({
      where: {
        role: "MANAGER",
        designationLevel,
        orgUnit: { departmentId },
        // Exclude the requesting user
        NOT: { userId },
      },
      select: { userId: true },
    });

    peers.forEach((p) => peerUserIds.add(p.userId));
  }

  return [...peerUserIds];
}

/**
 * Toggles peer-to-peer for a workspace. Upserts the settings row so it
 * works even if the row doesn't exist yet.
 * Returns the new state.
 */
export async function setPeerToPeer(
  workspaceId: string,
  enabled: boolean,
): Promise<boolean> {
  const settings = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { peerToPeerEnabled: enabled },
    select: { peerToPeerEnabled: true },
  });
  return settings.peerToPeerEnabled;
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

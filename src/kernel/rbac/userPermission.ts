import { prisma } from "@shared/config/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

// Every permission targets one specific module — no wildcards.
export type ResolvedPermission = {
  action: "read" | "write";
  appKey: string;
  moduleKey: string;
  appId: string;
  appName: string;
};

export type UserPermissions = {
  isSuperAdmin: boolean;
  permissions: ResolvedPermission[];
};

// ─────────────────────────────────────────────────────────────────────────────
// buildUserPermissions
//
// Fetches every permission row across all profiles the user holds.
// Returns a flat deduplicated array — one entry per (action, app, module).
//
// Example output for "Field Engineer":
// [
//   { action: "read",  appKey: "MAP", moduleKey: "EPC" },
//   { action: "write", appKey: "MAP", moduleKey: "EPC" },
//   { action: "read",  appKey: "MAP", moduleKey: "EPF" },
//   { action: "write", appKey: "MAP", moduleKey: "EPF" },
//   { action: "read",  appKey: "HR",  moduleKey: "PAYROLL" },
//   ...
// ]
// ─────────────────────────────────────────────────────────────────────────────

export async function buildUserPermissions(
  userId: string,
  workspaceId: string,
): Promise<UserPermissions> {
  const member = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { isSuperAdmin: true },
  });

  if (!member) return { isSuperAdmin: false, permissions: [] };
  // if (member.isSuperAdmin) return { isSuperAdmin: true, permissions: [] };

  // Single SQL query — joins UserProfile → Profile → ProfilePermission → Module → App
  // Every row now has a concrete appKey and moduleKey (no nulls possible).
  const rows = await prisma.$queryRaw<
    {
      action: string;
      appKey: string;
      moduleKey: string;
      appId: string;
      appName: string;
    }[]
  >`
    SELECT
      pp.action   AS "action",
      a.key       AS "appKey",
      a.id        AS "appId",
      a.name      AS "appName",
      m.key       AS "moduleKey"
    FROM "UserProfile"       up
    JOIN "Profile"           p  ON p.id  = up."profileId"
    JOIN "ProfilePermission" pp ON pp."profileId" = p.id
    JOIN "Module"            m  ON m.id  = pp."moduleId"
    JOIN "App"               a  ON a.id  = m."appId"
    WHERE up."userId"      = ${userId}
      AND up."workspaceId" = ${workspaceId}
  `;

  // Deduplicate — two profiles might both grant READ on EPC
  const seen = new Set<string>();
  const permissions: ResolvedPermission[] = [];

  for (const row of rows) {
    const key = `${row.action}|${row.appKey}|${row.moduleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    permissions.push({
      action: row.action as "read" | "write",
      appKey: row.appKey,
      appId: row.appId,
      appName: row.appName,
      moduleKey: row.moduleKey,
    });
  }

  return { isSuperAdmin: member.isSuperAdmin, permissions };
}

// ─────────────────────────────────────────────────────────────────────────────
// hasPermission
//
// Returns true if the user has an explicit grant for action + app + module.
// No wildcards — the match must be exact.
//
// Usage:
//   hasPermission(req.user, "write", "MAP", "EPC")  → true/false
// ─────────────────────────────────────────────────────────────────────────────

export function hasPermission(
  user: { isSuperAdmin: boolean; permissions: ResolvedPermission[] },
  action: "read" | "write",
  appKey: string,
  moduleKey: string,
): boolean {
  if (user.isSuperAdmin) return true;

  return user.permissions.some(
    (p) =>
      p.action === action && p.appKey === appKey && p.moduleKey === moduleKey,
  );
}

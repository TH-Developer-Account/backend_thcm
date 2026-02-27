import { prisma } from "../config/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

// One resolved permission entry attached to req.user
// Think of it as a single rule: "you can do X at this scope"
export type ResolvedPermission = {
  action: "read" | "write";
  scopeType: "WORKSPACE" | "APP" | "MODULE";
  appKey: string | null; // null when scopeType = WORKSPACE
  moduleKey: string | null; // null when scopeType = WORKSPACE or APP
};

// The full permissions payload stored on req.user
export type UserPermissions = {
  isSuperAdmin: boolean;
  permissions: ResolvedPermission[];
};

// ─────────────────────────────────────────────────────────────────────────────
// buildUserPermissions
//
// Called once per request (inside requireAuth) to build the user's
// complete set of permissions for a given workspace.
//
// OLD approach: one raw SQL query → expanded into { app: { module: [actions] } }
//   Problem: only worked for MODULE-scoped roles. WORKSPACE/APP scope
//   couldn't be represented in that flat map without knowing all modules upfront.
//
// NEW approach: fetch every ProfilePermission row across all profiles
//   the user holds, return them as a flat array with their scope intact.
//   The authorize() middleware then resolves at check time — no expansion needed.
//
// Example output for a "Field Engineer" (READ everywhere, WRITE on MAP):
// {
//   isSuperAdmin: false,
//   permissions: [
//     { action: "read",  scopeType: "WORKSPACE", appKey: null,  moduleKey: null },
//     { action: "write", scopeType: "APP",        appKey: "MAP", moduleKey: null },
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

export async function buildUserPermissions(
  userId: string,
  workspaceId: string,
): Promise<UserPermissions> {
  // Step 1 — Check workspace membership + superadmin status
  const member = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { isSuperAdmin: true },
  });

  // If the user isn't even a member of this workspace, return empty
  if (!member) {
    return { isSuperAdmin: false, permissions: [] };
  }

  // Superadmins bypass everything — no need to fetch permission rows
  if (member.isSuperAdmin) {
    return { isSuperAdmin: true, permissions: [] };
  }

  // Step 2 — Fetch all ProfilePermission rows across every profile this user holds.
  //
  // The join path is:
  //   UserProfile → Profile → ProfilePermission
  //                                └─ App    (to get appKey)
  //                                └─ Module (to get moduleKey)
  //
  // We use a raw query here for performance (single DB round trip instead of
  // multiple Prisma nested includes).
  const rows = await prisma.$queryRaw<
    {
      action: string;
      scopeType: string;
      appKey: string | null;
      moduleKey: string | null;
    }[]
  >`
    SELECT
      pp.action       AS "action",
      pp."scopeType"  AS "scopeType",
      a.key           AS "appKey",
      m.key           AS "moduleKey"
    FROM "UserProfile"       up
    JOIN "Profile"           p  ON p.id = up."profileId"
    JOIN "ProfilePermission" pp ON pp."profileId" = p.id
    LEFT JOIN "App"    a ON a.id = pp."appId"
    LEFT JOIN "Module" m ON m.id = pp."moduleId"
    WHERE up."userId"      = ${userId}
      AND up."workspaceId" = ${workspaceId}
  `;

  // Step 3 — Deduplicate rows (a user might hold two profiles that
  // both grant READ at WORKSPACE scope — we only need one copy).
  const seen = new Set<string>();
  const permissions: ResolvedPermission[] = [];

  for (const row of rows) {
    // Build a dedup key from all four fields
    const key = `${row.action}|${row.scopeType}|${row.appKey}|${row.moduleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);

    permissions.push({
      action: row.action as "read" | "write",
      scopeType: row.scopeType as "WORKSPACE" | "APP" | "MODULE",
      appKey: row.appKey,
      moduleKey: row.moduleKey,
    });
  }

  return { isSuperAdmin: false, permissions };
}

// ─────────────────────────────────────────────────────────────────────────────
// hasPermission
//
// Pure helper — checks whether a set of resolved permissions grants
// `action` for a specific app + module combination.
//
// Rules:
//   WORKSPACE scope → passes for any app/module (blanket grant)
//   APP scope       → passes only if appKey matches
//   MODULE scope    → passes only if both appKey and moduleKey match
//
// Usage (inside authorize middleware or anywhere you need a programmatic check):
//   if (hasPermission(req.user, "write", "MAP", "EPC")) { ... }
// ─────────────────────────────────────────────────────────────────────────────

export function hasPermission(
  user: { isSuperAdmin: boolean; permissions: ResolvedPermission[] },
  action: "read" | "write",
  appKey: string,
  moduleKey: string,
): boolean {
  // Superadmin always passes
  if (user.isSuperAdmin) return true;

  return user.permissions.some((p) => {
    // Action must match
    if (p.action !== action) return false;

    switch (p.scopeType) {
      // WORKSPACE → blanket, no further checks
      case "WORKSPACE":
        return true;

      // APP → must be the same app, any module within it is fine
      case "APP":
        return p.appKey === appKey;

      // MODULE → must match both app and module exactly
      case "MODULE":
        return p.appKey === appKey && p.moduleKey === moduleKey;

      default:
        return false;
    }
  });
}

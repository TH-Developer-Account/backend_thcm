import { prisma } from "@shared/config/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

// A permission row is one of two kinds now:
//   - MODULE scope: targets one specific module (moduleKey set)
//   - APP scope:    "admin of this whole app" — moduleKey is absent, since it
//                    covers every module under that app, current and future
export type ResolvedPermission = {
  action: "read" | "write";
  scope: "MODULE" | "APP";
  appKey: string;
  appId: string;
  appName: string;
  moduleKey?: string; // only present when scope === "MODULE"
};

export type UserPermissions = {
  isSuperAdmin: boolean;
  permissions: ResolvedPermission[];
};

// ─────────────────────────────────────────────────────────────────────────────
// buildUserPermissions
//
// Fetches every permission row across all profiles the user holds — now in
// TWO queries instead of one, since module-scope and app-scope rows join
// through different tables (Module vs. App directly). This is a deliberate,
// small cost: a UNION query would work but adds SQL complexity for a call
// that only runs once per login, not per request — not worth optimizing.
//
// Example output for a profile that's a MAP admin + has module access to HR:
// [
//   { action: "write", scope: "APP",    appKey: "MAP", moduleKey: undefined },
//   { action: "read",  scope: "MODULE", appKey: "HR",  moduleKey: "PAYROLL" },
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

  // ── Module-scope rows ──────────────────────────────────────────────────────
  const moduleRows = await prisma.$queryRaw<
    {
      action: string;
      appKey: string;
      appId: string;
      appName: string;
      moduleKey: string;
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
    JOIN "ProfilePermission" pp ON pp."profileId" = p.id AND pp.scope = 'MODULE'
    JOIN "Module"            m  ON m.id  = pp."moduleId"
    JOIN "App"               a  ON a.id  = m."appId"
    WHERE up."userId"      = ${userId}
      AND up."workspaceId" = ${workspaceId}
  `;

  // ── App-scope rows ("admin of this whole app") ─────────────────────────────
  const appRows = await prisma.$queryRaw<
    {
      action: string;
      appKey: string;
      appId: string;
      appName: string;
    }[]
  >`
    SELECT
      pp.action   AS "action",
      a.key       AS "appKey",
      a.id        AS "appId",
      a.name      AS "appName"
    FROM "UserProfile"       up
    JOIN "Profile"           p  ON p.id  = up."profileId"
    JOIN "ProfilePermission" pp ON pp."profileId" = p.id AND pp.scope = 'APP'
    JOIN "App"               a  ON a.id  = pp."appId"
    WHERE up."userId"      = ${userId}
      AND up."workspaceId" = ${workspaceId}
  `;

  // Deduplicate — two profiles might both grant the same row
  const seen = new Set<string>();
  const permissions: ResolvedPermission[] = [];

  for (const row of moduleRows) {
    const key = `MODULE|${row.action}|${row.appKey}|${row.moduleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    permissions.push({
      action: row.action as "read" | "write",
      scope: "MODULE",
      appKey: row.appKey,
      appId: row.appId,
      appName: row.appName,
      moduleKey: row.moduleKey,
    });
  }

  for (const row of appRows) {
    const key = `APP|${row.action}|${row.appKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    permissions.push({
      action: row.action as "read" | "write",
      scope: "APP",
      appKey: row.appKey,
      appId: row.appId,
      appName: row.appName,
    });
  }

  return { isSuperAdmin: member.isSuperAdmin, permissions };
}

// ─────────────────────────────────────────────────────────────────────────────
// hasPermission
//
// Returns true if the user has an explicit grant for action + app + module.
//
// Two ways this can be satisfied now:
//   1. An exact MODULE-scope match (original behavior, unchanged).
//   2. An APP-scope match on the same app with "write" — an app admin's
//      single row implicitly covers every module under that app, since
//      Module.appId already ties modules to their app. This is what lets
//      an app admin pass every authorize() check in their app without a
//      single module-scope row existing for them.
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

  const hasExactModuleGrant = user.permissions.some(
    (p) =>
      p.scope === "MODULE" &&
      p.action === action &&
      p.appKey === appKey &&
      p.moduleKey === moduleKey,
  );
  if (hasExactModuleGrant) return true;

  // App-admin fallback — a "write" app-scope grant covers every module
  // under that app, regardless of the requested action (write implies read).
  return user.permissions.some(
    (p) => p.scope === "APP" && p.appKey === appKey && p.action === "write",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// canManageApp
//
// Answers a DIFFERENT question than hasPermission: not "can this user act on
// module X" but "is this user this app's admin" — i.e. does an APP-scope
// write row exist for this app. Kept as a separate function rather than
// folded into hasPermission, since the two answer genuinely different
// questions (see workflowTemplate.controller.ts's resolveOwnerType, which
// needs exactly this — "is the caller eligible to create an app-wide
// template", not "can the caller act on a specific module").
//
// Usage:
//   canManageApp(req.user, "MAP")  → true/false
// ─────────────────────────────────────────────────────────────────────────────

export function canManageApp(
  user: { isSuperAdmin: boolean; permissions: ResolvedPermission[] },
  appKey: string,
): boolean {
  if (user.isSuperAdmin) return true;

  return user.permissions.some(
    (p) => p.scope === "APP" && p.appKey === appKey && p.action === "write",
  );
}

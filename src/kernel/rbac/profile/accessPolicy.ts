import type { AccessActor, PermissionActionValue } from "./access.types";

export function isSuperAdmin(actor: AccessActor): boolean {
  return actor.isSuperAdmin;
}

export function isAppAdministrator(
  actor: AccessActor,
  appKey: string,
): boolean {
  return (
    actor.isSuperAdmin ||
    actor.administeredApps.some((app) => app.appKey === appKey)
  );
}

export function canAccessAdministration(actor: AccessActor): boolean {
  return actor.isSuperAdmin || actor.administeredApps.length > 0;
}

// Returns null for "no restriction" so callers can skip the app filter in
// queries instead of listing every app id a super admin can see.
export function getManageableAppIds(actor: AccessActor): string[] | null {
  return actor.isSuperAdmin
    ? null
    : actor.administeredApps.map((app) => app.appId);
}

// An app's administrator can use every module of that app without holding a
// profile for it, so admin rights are checked before module grants.
export function hasModulePermission(
  actor: AccessActor,
  action: PermissionActionValue,
  appKey: string,
  moduleKey: string,
): boolean {
  return (
    isAppAdministrator(actor, appKey) ||
    actor.permissions.some(
      (permission) =>
        permission.action === action &&
        permission.appKey === appKey &&
        permission.moduleKey === moduleKey,
    )
  );
}

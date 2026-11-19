export type PermissionActionValue = "read" | "write";

export type AppSummary = {
  appId: string;
  appKey: string;
  appName: string;
};

export type ModulePermission = AppSummary & {
  action: PermissionActionValue;
  moduleKey: string;
};

// Everything an authorization decision needs, and nothing more — so policy
// functions stay pure and can be evaluated on the frontend with the same data.
export type AccessActor = {
  isSuperAdmin: boolean;
  administeredApps: AppSummary[];
  permissions: ModulePermission[];
};

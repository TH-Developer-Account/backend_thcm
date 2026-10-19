-- Dev-only reset: pre-app-scoped profile rows can't be migrated.
DELETE FROM "UserProfile";
DELETE FROM "ProfilePermission";
DELETE FROM "Profile";
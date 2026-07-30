// middleware/auth.ts
import jwt from "jsonwebtoken";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import {
  buildUserPermissions,
  hasPermission,
} from "@kernel/rbac/userPermission";

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth
//
// Runs on every protected route. It:
//   1. Reads and verifies the JWT from the Authorization header
//   2. Loads the user and their workspace membership
//   3. Calls buildUserPermissions to fetch all their scoped permission rows
//   4. Attaches everything to req.user for downstream middleware/controllers
//
// What changed from the old version:
//   - req.user.apps (nested map) is replaced by req.user.permissions (flat array)
//   - authorize() now uses hasPermission() to check the flat array
// ─────────────────────────────────────────────────────────────────────────────

export const requireAuth = async (req, res, next) => {
  try {
    // ── Step 1: Extract and verify JWT ──────────────────────────────────────
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : (req.query.token as string | undefined); // EventSource fallback

    if (!token) {
      throw new ApiError(401, "No token provided");
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      sub: string;
    };

    // ── Step 2: Load user + their workspace memberships ─────────────────────
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        is_active: true,
        workspaceUsers: {
          select: {
            workspaceId: true,
            isSuperAdmin: true,
          },
        },
      },
    });

    if (!user || !user.is_active) {
      throw new ApiError(401, "User not authorized");
    }

    // For now we take the first workspace the user belongs to.
    // In a multi-workspace UI, you'd read the workspaceId from a
    // request header (e.g. X-Workspace-Id) instead.
    const workspace = user.workspaceUsers[0];
    if (!workspace) {
      throw new ApiError(403, "User does not belong to any workspace");
    }

    // ── Step 3: Build scoped permissions ────────────────────────────────────
    // This is one DB round trip — a single raw SQL query that joins
    // UserProfile → Profile → ProfilePermission → App → Module.
    const { isSuperAdmin, permissions } = await buildUserPermissions(
      user.id,
      workspace.workspaceId,
    );

    // ── Step 4: Attach to req.user ───────────────────────────────────────────
    req.user = {
      id: user.id,
      email: user.email,
      workspaceId: workspace.workspaceId,
      isSuperAdmin,
      permissions,
    };

    next();
  } catch (error) {
    // Return 401 for any auth failure (expired token, user not found, etc.)
    res.sendStatus(401);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// authorize
//
// Route-level middleware. Place it after requireAuth on any route that
// needs a permission check.
//
// Usage on a route:
//   router.post(
//     "/events",
//     requireAuth,
//     authorize("MAP", "EPC", "write"),
//     createEventHandler
//   );
//
// How it works:
//   1. Superadmin → always passes
//   2. Calls hasPermission() which walks req.user.permissions and checks
//      whether ANY row grants the requested action at the right scope
//
// What changed from the old version:
//   Old: checked req.user.apps[app][module].includes(action)
//        → only worked for MODULE-scoped roles, WORKSPACE/APP scope was invisible
//   New: checks the flat permissions array using scope-aware matching
//        → a single WORKSPACE "read" row now covers every app and module
// ─────────────────────────────────────────────────────────────────────────────

export function authorize(
  app: string,
  module: string,
  action: "read" | "write",
) {
  return (req, res, next) => {
    // Superadmin short-circuit — skip permission lookup entirely
    if (req.user?.isSuperAdmin) return next();

    // Use hasPermission to resolve the flat array against the requested context
    const allowed = hasPermission(
      { isSuperAdmin: false, permissions: req.user?.permissions ?? [] },
      action,
      app,
      module,
    );

    if (!allowed) {
      return res.status(403).json({
        message: "Forbidden",
        // Helpful debug info in development — remove in production
        ...(process.env.NODE_ENV === "development" && {
          required: { app, module, action },
        }),
      });
    }

    next();
  };
}

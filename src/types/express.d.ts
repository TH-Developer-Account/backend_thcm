import { ResolvedPermission } from "../utils/userPermission";
import {
  VendorAccessToken,
  VendorOnboarding,
} from "../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Extend Express's Request type so TypeScript knows about req.user
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        workspaceId: string;
        isSuperAdmin: boolean;
        // Flat list of scoped permission rules — replaces the old nested map.
        // Old: { MAP: { EPC: ["read", "write"] } }
        // New: [{ action: "write", scopeType: "APP", appKey: "MAP", moduleKey: null }]
        //
        // The flat array is simpler to reason about because one WORKSPACE-scoped
        // "read" row now covers every app/module — no expansion needed.
        permissions: ResolvedPermission[];
      };
      vendorAccessToken?: VendorAccessToken & {
        onboarding: VendorOnboarding;
      };
    }
  }
}

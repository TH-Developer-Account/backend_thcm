import { ResolvedPermission } from "../kernel/rbac/userPermission";
import {
  VendorAccessToken,
  VendorOnboarding,
  MedicalClaim,
} from "../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Extend Express's Request type so TypeScript knows about req.user
//
// Express 5's own types route Request.user through Express.User (this used
// to be a Passport convention; Express 5 baked it into core). Augmenting
// Express.Request.user directly (the old Express 4 pattern) no longer merges
// — Request.user is typed as Express.User | undefined, so Express.User is
// what needs augmenting.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      workspaceId: string;
      isSuperAdmin: boolean;
      permissions: ResolvedPermission[];
    }

    interface Request {
      vendorAccessToken?:
        | { id: string; onboarding: VendorOnboarding }
        | undefined;

      medicalClaimAccessToken?: { id: string; claim: MedicalClaim } | undefined;

      // A guest is not a User — no workspaceId, no permissions. Kept as
      // a plain object rather than folded into Express.User, since the
      // two identities are never valid at the same time on one request.
      guest?: {
        id: string;
        mobile: string | null;
        email: string | null;
      };
    }
  }
}

export type AuthenticatedUser = {
  id: string;
  email: string;
  workspaceId: string;
  isSuperAdmin: boolean;
  permissions: ResolvedPermission[];
};

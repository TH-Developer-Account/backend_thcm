import type { AccessActor } from "@rbac/profile/access.types";
import type {
  VendorOnboarding,
  MedicalClaim,
} from "../prisma/generated/prisma/client";

export type AuthenticatedUser = AccessActor & {
  id: string;
  email: string | null;
  workspaceId: string;
};

// @types/express 5 does not declare Request.user (it came from Passport), so
// it is declared here; Express.User keeps compatibility with that convention.
declare global {
  namespace Express {
    interface User extends AuthenticatedUser {}

    interface Request {
      user?: User;

      vendorAccessToken?:
        | { id: string; onboarding: VendorOnboarding }
        | undefined;

      medicalClaimAccessToken?: { id: string; claim: MedicalClaim } | undefined;

      // A guest is never a User: the two identities are never valid on the
      // same request, so a guest has no workspace and no permissions.
      guest?: {
        id: string;
        mobile: string | null;
        email: string | null;
      };
    }
  }
}

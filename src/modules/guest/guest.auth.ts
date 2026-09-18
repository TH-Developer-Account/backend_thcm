import jwt from "jsonwebtoken";

// Deliberately NOT reusing signAccessToken's payload shape.
// A guest has no workspaceId/isSuperAdmin — inventing placeholder values
// for those fields would let a guest token silently satisfy staff-only
// checks if requireAuth were ever loosened. `type: "GUEST"` makes the
// two token kinds structurally distinct, not just conventionally distinct.
type GuestTokenPayload = {
  sub: string; // Guest.id
  type: "GUEST";
};

const GUEST_TOKEN_TTL = "24h"; // confirmed: single longer-lived session, re-OTP after expiry — no refresh token

export const signGuestAccessToken = (guestId: string) => {
  return jwt.sign(
    { sub: guestId, type: "GUEST" } satisfies GuestTokenPayload,
    process.env.ACCESS_TOKEN_SECRET!,
    { expiresIn: GUEST_TOKEN_TTL },
  );
};

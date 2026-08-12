import { Prisma } from "../../prisma/generated/prisma/client";
import { createGuestCredentials } from "./guest.credential";

type Tx = Prisma.TransactionClient;

export type LinkOrCreateGuestResult = {
  guestId: string;
  isNewGuest: boolean;
  plainPassword: string | null; // only set when a new guest was created with an email
};

// Called from initiateVendorOnboarding / initiateMedicalClaim now that
// guest creation happens at STAFF-INITIATION time, not first submission —
// there is no more token-based first touch, so the guest identity has to
// exist before any link/credentials can be sent at all.
//
// Identical logic to what used to live inline in submitVendorForm and
// submitMedicalClaimForm — pulled out once both call sites needed it at
// the same lifecycle point, so it doesn't drift between the two apps.
export async function linkOrCreateGuestForSubject(
  tx: Tx,
  identity: { mobile: string; email?: string | null },
): Promise<LinkOrCreateGuestResult> {
  const existingGuest = await tx.guest.findUnique({
    where: { mobile: identity.mobile },
  });

  if (existingGuest) {
    return {
      guestId: existingGuest.id,
      isNewGuest: false,
      plainPassword: null,
    };
  }

  const guest = await tx.guest.create({
    data: { mobile: identity.mobile, email: identity.email },
  });

  if (!identity.email) {
    return { guestId: guest.id, isNewGuest: true, plainPassword: null };
  }

  const { plainPassword, hashedPassword } = await createGuestCredentials();
  await tx.guest.update({
    where: { id: guest.id },
    data: { password: hashedPassword },
  });

  return { guestId: guest.id, isNewGuest: true, plainPassword };
}

/**
 * modules/map/crfDispatchDetails.service.ts
 *
 * PUT /crf/:crfId/dispatch-details — recipient + shipping address, entered
 * after EPC approval, before the order is placed with Shopify. Kept as its
 * own file rather than folded into crf.service.ts: that file owns CRF line
 * items (drafting-time concern, gated on CRF.status === OPEN); this one
 * owns recipient/address (post-approval concern, gated on a disjoint set of
 * statuses). Different lifecycle stage, different status gate, same CRF —
 * separating them keeps each file's reason to change singular.
 *
 * Only structural validation happens here (required fields present,
 * country is India, pincode is 6 digits). The real address validation
 * (does this PIN exist, does the state/city match it) is THCM's — it
 * re-validates on every Create Order call and returns INVALID_PIN /
 * PIN_STATE_MISMATCH / PIN_CITY_MISMATCH, which crfOrder.service.ts will
 * surface back to the proposer. Duplicating THCM's PIN dataset here would
 * just be a second copy of logic that can drift from theirs.
 */

import { Prisma } from "../../../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  getCrfAccess,
  assertCrfAccess,
  DISPATCH_EDITABLE_STATUSES,
} from "@modules/map/crf/crfAccess.helper";

type Actor = AccessActor & { id: string };

const RECIPIENT_TYPES = [
  "SELF",
  "EMPLOYEE",
  "DEALER_CONTACT",
  "OTHER",
] as const;
type RecipientType = (typeof RECIPIENT_TYPES)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_PATTERN = /^\d{6}$/;

export type DispatchDetailsAddressInput = {
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  district?: string;
  state: string;
  pincode: string;
  country?: string;
  company?: string;
  gstin?: string;
};

export type DispatchDetailsInput = {
  recipientType: RecipientType;
  recipientName: string;
  recipientPhone: string;
  recipientEmail: string;
  recipientOrganisation?: string;
  recipientUserId?: string;
  recipientContactId?: string;
  deliveryInstructions?: string;
  requiredByDate?: string;
  address: DispatchDetailsAddressInput;
};

function assertNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ApiError(400, `${field} is required`);
  return trimmed;
}

async function buildRecipientFields(
  tx: Prisma.TransactionClient,
  input: DispatchDetailsInput,
) {
  if (!RECIPIENT_TYPES.includes(input.recipientType)) {
    throw new ApiError(
      400,
      `recipientType must be one of: ${RECIPIENT_TYPES.join(", ")}`,
    );
  }

  const name = assertNonEmpty(input.recipientName, "recipientName");
  if (name.length > 255) {
    throw new ApiError(400, "recipientName must be at most 255 characters");
  }

  const phone = assertNonEmpty(input.recipientPhone, "recipientPhone");

  const email = assertNonEmpty(
    input.recipientEmail,
    "recipientEmail",
  ).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 255) {
    throw new ApiError(400, "recipientEmail must be a valid email address");
  }

  let recipientUserId: string | null = null;
  if (input.recipientType === "EMPLOYEE") {
    recipientUserId = assertNonEmpty(input.recipientUserId, "recipientUserId");
    const user = await tx.user.findUnique({ where: { id: recipientUserId } });
    if (!user) throw new ApiError(400, "recipientUserId does not exist");
  }

  let recipientContactId: string | null = null;
  if (input.recipientType === "DEALER_CONTACT") {
    recipientContactId = assertNonEmpty(
      input.recipientContactId,
      "recipientContactId",
    );
    const contact = await tx.businessPartnerContact.findUnique({
      where: { id: recipientContactId },
    });
    if (!contact) throw new ApiError(400, "recipientContactId does not exist");
  }

  return {
    recipientType: input.recipientType,
    recipientName: name,
    recipientPhone: phone,
    recipientEmail: email,
    recipientOrganisation: input.recipientOrganisation?.trim() || null,
    recipientUserId,
    recipientContactId,
    deliveryInstructions: input.deliveryInstructions?.trim() || null,
    requiredByDate: input.requiredByDate
      ? new Date(input.requiredByDate)
      : null,
  };
}

function buildAddressFields(address: DispatchDetailsAddressInput) {
  const line1 = assertNonEmpty(address.line1, "address.line1");
  const city = assertNonEmpty(address.city, "address.city");
  const state = assertNonEmpty(address.state, "address.state");
  const pincode = assertNonEmpty(address.pincode, "address.pincode");

  if (!PINCODE_PATTERN.test(pincode)) {
    throw new ApiError(400, "address.pincode must be exactly 6 digits");
  }

  const country = address.country?.trim() || "India";
  if (country.toLowerCase() !== "india") {
    // THCM only ships within India today — fail here rather than waiting
    // for THCM's own INVALID_COUNTRY response at order time.
    throw new ApiError(400, "address.country must be India");
  }

  return {
    addressLine1: line1,
    addressLine2: address.line2?.trim() || null,
    addressLandmark: address.landmark?.trim() || null,
    addressCity: city,
    addressDistrict: address.district?.trim() || null,
    addressState: state,
    addressPincode: pincode,
    addressCountry: country,
    addressCompany: address.company?.trim() || null,
    addressGstin: address.gstin?.trim() || null,
    addressValidatedAt: null, // set once crfOrder.service.ts gets a clean validation from THCM
  };
}

/**
 * updateDispatchDetails — all-or-nothing: either the full recipient +
 * address payload is saved, or nothing is (the request is rejected with
 * whatever field was missing/invalid). No partial-draft state to track.
 */
export async function updateDispatchDetails(
  actor: Actor,
  crfId: string,
  input: DispatchDetailsInput,
) {
  const access = await getCrfAccess(actor, crfId);
  assertCrfAccess(access);

  if (!access.isOwner) {
    throw new ApiError(
      403,
      "Only the CRF's creator can edit its dispatch details",
    );
  }
  const editableStatuses: readonly string[] = DISPATCH_EDITABLE_STATUSES;
  if (!editableStatuses.includes(access.crf.status)) {
    throw new ApiError(
      409,
      `Dispatch details can only be edited while the CRF is APPROVED, STOCK_SHORTFALL or ORDER_FAILED (current status: ${access.crf.status})`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const recipientFields = await buildRecipientFields(tx, input);
    const addressFields = buildAddressFields(input.address);

    const crf = await tx.cRF.update({
      where: { id: crfId },
      data: {
        ...recipientFields,
        ...addressFields,
        updated_by_id: actor.id,
      },
    });

    await tx.activityLog.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: access.crf.epcId,
        actorId: actor.id,
        action: "CRF_DISPATCH_DETAILS_UPDATED",
        workflowId: null,
        stageId: null,
        metadata: { reason: "CRF dispatch details updated." },
      },
    });

    return crf;
  });
}

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import {
  BusinessPartner,
  BusinessPartnerOfficeType,
  Prisma,
} from "../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBusinessPartnerInput {
  vendorId?: string;
  bpId?: string;
  s4Id?: string;
  bydId?: string;
  c4cId?: string;
  bpName: string;
  bpShortName?: string;
  isKeyAccount?: boolean;
  gst?: string;
  panNumber?: string;
  legalTradeName?: string;
  officeType: BusinessPartnerOfficeType;
  bpType: string;
  entityType?: string;
  vendorCode?: string;
  joinedOn?: Date;
  parentId?: string;
}

export type UpdateBusinessPartnerInput = Partial<CreateBusinessPartnerInput>;

export interface ListBusinessPartnersFilters {
  search?: string;
  officeType?: BusinessPartnerOfficeType;
  bpType?: string;
  isActive?: boolean;
  parentId?: string | null;
  page?: number;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// assertParentIsHeadOffice
//
// A branch's parent must be a HEAD_OFFICE row — that's the only thing enforced
// here. A BRANCH_OFFICE is otherwise a fully independent BusinessPartner: its
// own gst, panNumber, legalTradeName, addresses, and contacts. Nothing is
// copied from the parent.
// ─────────────────────────────────────────────────────────────────────────────

async function assertParentIsHeadOffice(
  parentId: string,
): Promise<BusinessPartner> {
  const parent = await prisma.businessPartner.findUnique({
    where: { id: parentId },
  });
  if (!parent) throw new ApiError(404, "Parent business partner not found");
  if (parent.officeType !== BusinessPartnerOfficeType.HEAD_OFFICE) {
    throw new ApiError(
      400,
      "parentId must reference a HEAD_OFFICE business partner",
    );
  }
  return parent;
}

// ─────────────────────────────────────────────────────────────────────────────
// createBusinessPartner
// ─────────────────────────────────────────────────────────────────────────────

export async function createBusinessPartner(
  input: CreateBusinessPartnerInput,
): Promise<BusinessPartner> {
  if (!input.bpName?.trim()) throw new ApiError(400, "bpName is required");

  if (input.officeType === BusinessPartnerOfficeType.BRANCH_OFFICE) {
    if (!input.parentId) {
      throw new ApiError(
        400,
        "parentId is required for a BRANCH_OFFICE business partner",
      );
    }
    await assertParentIsHeadOffice(input.parentId);
  } else if (input.parentId) {
    throw new ApiError(
      400,
      "A HEAD_OFFICE business partner cannot have a parentId",
    );
  }

  return prisma.businessPartner.create({ data: input });
}

// ─────────────────────────────────────────────────────────────────────────────
// getBusinessPartnerById
// ─────────────────────────────────────────────────────────────────────────────

export async function getBusinessPartnerById(
  id: string,
): Promise<BusinessPartner> {
  const businessPartner = await prisma.businessPartner.findUnique({
    where: { id },
    include: {
      parent: { select: { id: true, bpName: true, officeType: true } },
      branches: { select: { id: true, bpName: true, isActive: true } },
      addresses: true,
      contacts: true,
    },
  });

  if (!businessPartner) throw new ApiError(404, "Business partner not found");
  return businessPartner;
}

// ─────────────────────────────────────────────────────────────────────────────
// listBusinessPartners
// ─────────────────────────────────────────────────────────────────────────────

export async function listBusinessPartners(
  filters: ListBusinessPartnersFilters,
) {
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;

  const where: Prisma.BusinessPartnerWhereInput = {
    ...(filters.officeType && { officeType: filters.officeType }),
    ...(filters.bpType && { bpType: filters.bpType }),
    ...(filters.isActive !== undefined && { isActive: filters.isActive }),
    ...(filters.parentId !== undefined && { parentId: filters.parentId }),
    ...(filters.search && {
      OR: [
        { bpName: { contains: filters.search, mode: "insensitive" } },
        { bpShortName: { contains: filters.search, mode: "insensitive" } },
        { gst: { contains: filters.search, mode: "insensitive" } },
        { vendorCode: { contains: filters.search, mode: "insensitive" } },
      ],
    }),
  };

  const [data, total] = await prisma.$transaction([
    prisma.businessPartner.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { bpName: "asc" },
      select: {
        id: true,
        bpName: true,
        bpShortName: true,
        officeType: true,
        bpType: true,
        gst: true,
        isActive: true,
        parentId: true,
      },
    }),
    prisma.businessPartner.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ─────────────────────────────────────────────────────────────────────────────
// updateBusinessPartner
//
// Reassigning parentId or officeType after creation is deliberately not
// supported here — that's a re-parenting operation with its own semantics,
// not a plain field update. Keeping it out avoids a silent, easy-to-misuse
// path; add a dedicated reparent function later if you actually need it.
// ─────────────────────────────────────────────────────────────────────────────

export async function updateBusinessPartner(
  id: string,
  input: UpdateBusinessPartnerInput,
): Promise<BusinessPartner> {
  const existing = await prisma.businessPartner.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Business partner not found");

  const { parentId, officeType, ...rest } = input;
  if (parentId !== undefined || officeType !== undefined) {
    throw new ApiError(
      400,
      "parentId and officeType cannot be changed via update — this endpoint only edits BP attributes",
    );
  }

  return prisma.businessPartner.update({ where: { id }, data: rest });
}

// ─────────────────────────────────────────────────────────────────────────────
// deactivateBusinessPartner (soft delete)
//
// Deactivating a HEAD_OFFICE cascades isActive=false to its branches — an
// inactive HO with active branches is an inconsistent state the caller
// shouldn't have to clean up by hand.
// ─────────────────────────────────────────────────────────────────────────────

export async function deactivateBusinessPartner(
  id: string,
): Promise<BusinessPartner> {
  const existing = await prisma.businessPartner.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Business partner not found");

  const [deactivated] = await prisma.$transaction([
    prisma.businessPartner.update({ where: { id }, data: { isActive: false } }),
    prisma.businessPartner.updateMany({
      where: { parentId: id },
      data: { isActive: false },
    }),
  ]);

  return deactivated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — Contact / Address
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBusinessPartnerContactInput {
  name: string;
  phoneNumber?: string;
  email?: string;
  panNumber?: string;
  isOwner?: boolean;
  isMainContact?: boolean;
  userId?: string;
}
export type UpdateBusinessPartnerContactInput =
  Partial<CreateBusinessPartnerContactInput>;

export interface CreateBusinessPartnerAddressInput {
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  pincode?: string;
  region?: string;
  zone?: string;
  branch?: string;
  latitude?: number;
  longitude?: number;
  email?: string;
  phoneNo?: string;
  website?: string;
  isDefault?: boolean;
  isBillingAddress?: boolean;
  isShippingAddress?: boolean;
}
export type UpdateBusinessPartnerAddressInput =
  Partial<CreateBusinessPartnerAddressInput>;

// Included on every contact read so the caller gets user details for free
// instead of making a second round trip.
const contactUserSelect = {
  select: { id: true, name: true, email: true, phoneNumber: true },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// assertBusinessPartnerExists
//
// Shared 404 guard for the contact/address services below — gives a clean
// ApiError instead of letting Prisma's FK constraint surface a raw DB error.
// ─────────────────────────────────────────────────────────────────────────────

export async function assertBusinessPartnerExists(id: string): Promise<void> {
  const businessPartner = await prisma.businessPartner.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!businessPartner) throw new ApiError(404, "Business partner not found");
}

// ─────────────────────────────────────────────────────────────────────────────
// BusinessPartnerContact
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUserOrThrow(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone_number: true,
    },
  });
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

function resolveContactFieldsFromUser(user: {
  first_name: string;
  last_name: string;
  email: string | null;
  phone_number: string | null;
}) {
  return {
    name: `${user.first_name} ${user.last_name}`.trim(),
    email: user.email ?? undefined,
    phoneNumber: user.phone_number ?? undefined,
  };
}

export async function createBusinessPartnerContact(
  businessPartnerId: string,
  input: CreateBusinessPartnerContactInput,
) {
  await assertBusinessPartnerExists(businessPartnerId);

  const resolvedFields = input.userId
    ? resolveContactFieldsFromUser(await fetchUserOrThrow(input.userId))
    : {};

  return prisma.businessPartnerContact.create({
    data: { ...input, ...resolvedFields, businessPartnerId },
    include: { user: contactUserSelect },
  });
}

export async function listBusinessPartnerContacts(businessPartnerId: string) {
  await assertBusinessPartnerExists(businessPartnerId);

  return prisma.businessPartnerContact.findMany({
    where: { businessPartnerId },
    include: { user: contactUserSelect },
    orderBy: { createdAt: "asc" },
  });
}

export async function getBusinessPartnerContactById(
  businessPartnerId: string,
  id: string,
) {
  const contact = await prisma.businessPartnerContact.findFirst({
    where: { id, businessPartnerId },
    include: { user: contactUserSelect },
  });
  if (!contact) throw new ApiError(404, "Contact not found");
  return contact;
}

export async function updateBusinessPartnerContact(
  businessPartnerId: string,
  id: string,
  input: UpdateBusinessPartnerContactInput,
) {
  await getBusinessPartnerContactById(businessPartnerId, id); // 404 guard

  const resolvedFields = input.userId
    ? resolveContactFieldsFromUser(await fetchUserOrThrow(input.userId))
    : {};

  return prisma.businessPartnerContact.update({
    where: { id },
    data: { ...input, ...resolvedFields },
    include: { user: contactUserSelect },
  });
}

export async function deleteBusinessPartnerContact(
  businessPartnerId: string,
  id: string,
): Promise<void> {
  const contact = await getBusinessPartnerContactById(businessPartnerId, id); // 404 guard

  if (contact.isMainContact) {
    throw new ApiError(
      400,
      "Cannot delete the main contact. Set another contact as the main contact before deleting this one.",
    );
  }

  await prisma.businessPartnerContact.delete({ where: { id } });
}

// ─────────────────────────────────────────────────────────────────────────────
// BusinessPartnerAddress
// ─────────────────────────────────────────────────────────────────────────────

type ExclusiveAddressFlag =
  | "isDefault"
  | "isBillingAddress"
  | "isShippingAddress";
const EXCLUSIVE_ADDRESS_FLAGS: ExclusiveAddressFlag[] = [
  "isDefault",
  "isBillingAddress",
  "isShippingAddress",
];

// ─────────────────────────────────────────────────────────────────────────────
// resetExclusiveAddressFlags
//
// isDefault / isBillingAddress / isShippingAddress are single-select per BP:
// turning one on for an address must turn it off everywhere else on the same
// BP. Runs inside the caller's transaction so the "unset old, set new" pair
// is atomic — excludeId keeps an update from unsetting the very row it's
// about to set the flag on.
// ─────────────────────────────────────────────────────────────────────────────

async function resetExclusiveAddressFlags(
  tx: Prisma.TransactionClient,
  businessPartnerId: string,
  input: CreateBusinessPartnerAddressInput | UpdateBusinessPartnerAddressInput,
  excludeId?: string,
): Promise<void> {
  for (const flag of EXCLUSIVE_ADDRESS_FLAGS) {
    if (input[flag] !== true) continue;

    await tx.businessPartnerAddress.updateMany({
      where: {
        businessPartnerId,
        [flag]: true,
        ...(excludeId && { id: { not: excludeId } }),
      } as Prisma.BusinessPartnerAddressWhereInput,
      data: {
        [flag]: false,
      } as Prisma.BusinessPartnerAddressUpdateManyMutationInput,
    });
  }
}

export async function createBusinessPartnerAddress(
  businessPartnerId: string,
  input: CreateBusinessPartnerAddressInput,
) {
  await assertBusinessPartnerExists(businessPartnerId);

  return prisma.$transaction(async (tx) => {
    await resetExclusiveAddressFlags(tx, businessPartnerId, input);
    return tx.businessPartnerAddress.create({
      data: { ...input, businessPartnerId },
    });
  });
}

export async function updateBusinessPartnerAddress(
  businessPartnerId: string,
  id: string,
  input: UpdateBusinessPartnerAddressInput,
) {
  await getBusinessPartnerAddressById(businessPartnerId, id); // 404 guard

  return prisma.$transaction(async (tx) => {
    await resetExclusiveAddressFlags(tx, businessPartnerId, input, id);
    return tx.businessPartnerAddress.update({
      where: { id },
      data: input,
    });
  });
}

export async function listBusinessPartnerAddresses(businessPartnerId: string) {
  await assertBusinessPartnerExists(businessPartnerId);

  return prisma.businessPartnerAddress.findMany({
    where: { businessPartnerId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getBusinessPartnerAddressById(
  businessPartnerId: string,
  id: string,
) {
  const address = await prisma.businessPartnerAddress.findFirst({
    where: { id, businessPartnerId },
  });
  if (!address) throw new ApiError(404, "Address not found");
  return address;
}

export async function deleteBusinessPartnerAddress(
  businessPartnerId: string,
  id: string,
): Promise<void> {
  const address = await getBusinessPartnerAddressById(businessPartnerId, id); // 404 guard

  const activeFlags = EXCLUSIVE_ADDRESS_FLAGS.filter((flag) => address[flag]);
  if (activeFlags.length > 0) {
    throw new ApiError(
      400,
      `Cannot delete an address marked as ${activeFlags.join(", ")}. Unset it, or set another address as the new one, before deleting.`,
    );
  }

  await prisma.businessPartnerAddress.delete({ where: { id } });
}

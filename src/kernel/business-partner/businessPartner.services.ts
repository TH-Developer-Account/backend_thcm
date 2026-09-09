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

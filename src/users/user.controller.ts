import type { Request, Response } from "express";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { getRouteParameter } from "@shared/utils/routerParameter";
import { fetchOData, unwrapODataResults } from "@shared/utils/odata";
import {
  buildEqualityFilters,
  businessPartnerSelect,
  parsePaginationParams,
} from "@shared/utils/helpers";
import { getAuthenticatedUser } from "@kernel/auth/auth.middleware";
import { getManageableAppIds } from "@rbac/profile/accessPolicy";

import type { Prisma } from "../prisma/generated/prisma/client";

// Admin-created accounts get the same plain-text placeholder as the bulk
// imports: login compares it directly while is_default_login is true and
// forces a reset before a real (hashed) password is ever stored.
const DEFAULT_PASSWORD = "Welcome@2026";

// Allowlist rather than "everything except password": a new column on User
// must be opted in here before a request body can write to it.
const EDITABLE_USER_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "employeeCode",
  "bydId",
  "s4Id",
  "tallyId",
  "c4cId",
  "region",
  "address",
  "zone",
  "branch",
  "department",
  "role",
  "designation",
  "vertical",
  "managerCode1",
  "managerCode2",
  "isDefaultContact",
  "userType",
  "joinedOn",
  "grade",
  "businessPartnerId",
] as const;

const USER_FIELDS_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone_number: true,
  is_active: true,
  is_default_login: true,
  employeeCode: true,
  bydId: true,
  s4Id: true,
  tallyId: true,
  c4cId: true,
  region: true,
  address: true,
  zone: true,
  branch: true,
  department: true,
  role: true,
  designation: true,
  vertical: true,
  managerCode1: true,
  managerCode2: true,
  isDefaultContact: true,
  userType: true,
  joinedOn: true,
  grade: true,
  businessPartnerId: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.UserSelect;

const BYD_EMPLOYEES_URL =
  "https://my347749.sapbydesign.com/sap/byd/odata/cc_home_analytics.svc/RPZD655449B1A636628E3B774QueryResults?$select=Ts1ANs627E6567A30CCE2,CCOMPANY_UUID,TCOMPANY_UUID,CY4M9FABQY_37FB16C540,Ts1ANsB16243B33AE70B6,CEMPLOYEE_UUID,TEMPLOYEE_UUID,CWA_START_DATE,Cs1ANsDEEFA17BFFCF618,Ts1ANsA4889B6AD57D2F6,Ts1ANs188C5F1E104E8F1,CEE_PRIV_MAIL,CEE_PRIV_MOBILE,Ts1ANs564DE5EF7E2FC4D,Ts1ANsE819527096E9697,CWA_END_DATE,Ts1ANs6AE1BC19D4E7A30,Ts1ANsE1AB739751277B4&$top=10&$format=json";

const C4C_EMPLOYEES_URL =
  "https://my349841.crm.ondemand.com/sap/c4c/odata/ana_businessanalytics_analytics.svc/RPZ4EA7D91CAB6B391554B8F0QueryResults?$select=TSTAFFED_OC_UUID,CWRKADRS_EMAIL,CEE_UUID,CEE_GIVEN_NAME,TJOB_UUID,CEE_FAMILY_NAME,CRESP_MANAGER_UUID,TRESP_MANAGER_UUID,CWRKADRS_FRM_MOBILE,CEMPL_TYPE_START_DATE,CEMPL_TYPE_END_DATE&$top=10&$format=json";

// App admins see every user, but only the profiles of apps they administer:
// another app's assignments are not theirs to read.
function buildUserSelect(
  workspaceId: string,
  manageableAppIds: string[] | null,
) {
  return {
    ...USER_FIELDS_SELECT,
    businessPartner: { select: businessPartnerSelect },
    userProfiles: {
      where: {
        workspaceId,
        ...(manageableAppIds && { appId: { in: manageableAppIds } }),
      },
      select: {
        assignedAt: true,
        profile: {
          select: {
            id: true,
            name: true,
            app: { select: { key: true, name: true } },
          },
        },
      },
    },
  } satisfies Prisma.UserSelect;
}

type UserWithAppAccess = Prisma.UserGetPayload<{
  select: ReturnType<typeof buildUserSelect>;
}>;

function formatUser({ userProfiles, ...user }: UserWithAppAccess) {
  return {
    ...user,
    appAccess: userProfiles.map(({ profile, assignedAt }) => ({
      appKey: profile.app.key,
      appName: profile.app.name,
      profileId: profile.id,
      profileName: profile.name,
      assignedAt,
    })),
  };
}

function pickEditableUserFields(body: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const field of EDITABLE_USER_FIELDS) {
    if (body[field] !== undefined) fields[field] = body[field];
  }

  // Unique columns: an empty string would collide across users, null does not.
  if (fields.email === "") fields.email = null;
  if (fields.phone_number === "") fields.phone_number = null;
  if (fields.joinedOn !== undefined) {
    fields.joinedOn = fields.joinedOn
      ? new Date(fields.joinedOn as string)
      : null;
  }
  return fields;
}

async function assertBusinessPartnerExists(businessPartnerId: unknown) {
  if (typeof businessPartnerId !== "string" || !businessPartnerId) return;
  const businessPartner = await prisma.businessPartner.findUnique({
    where: { id: businessPartnerId },
    select: { id: true },
  });
  if (!businessPartner) throw new ApiError(404, "Business partner not found");
}

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceUser.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { userId: true },
  });
  if (!membership) throw new ApiError(404, "User not found in this workspace");
}

function respondWithODataResults(url: string, environmentPrefix: string) {
  return async (_request: Request, response: Response): Promise<void> => {
    response.json(unwrapODataResults(await fetchOData(url, environmentPrefix)));
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// src/users/user.controller.ts — replace USER_LIST_EQUALITY_FILTERS and the
// whole getUsers function with the code below. Imports are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const USER_LIST_EQUALITY_FILTERS = ["businessPartnerId", "userType"];

// User stores only is_active; the status names match the frontend tabs.
const USER_STATUS_FILTERS: Record<string, Prisma.UserWhereInput> = {
  Active: { is_active: true },
  Inactive: { is_active: false },
};

function buildUserSearchFilter(
  searchTerm: string | undefined,
): Prisma.UserWhereInput {
  if (!searchTerm) return {};
  const contains = { contains: searchTerm, mode: "insensitive" as const };
  return {
    OR: [
      { first_name: contains },
      { last_name: contains },
      { email: contains },
      { phone_number: contains },
      { employeeCode: contains },
    ],
  };
}

export async function getUsers(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const manageableAppIds = getManageableAppIds(actor);
  const { search, pageIndex, pageSize, profileId, status } =
    request.query as Record<string, string | undefined>;
  const { reqPageIndex, reqPageSize } = parsePaginationParams(
    pageIndex,
    pageSize,
  );

  const statusFilter = status ? USER_STATUS_FILTERS[status] : {};
  if (!statusFilter) {
    throw new ApiError(
      400,
      `Unknown status "${status}". Use Active or Inactive.`,
    );
  }

  // Everything except the status filter: the tab counts are computed from
  // this, so switching tabs never changes the numbers on the other tabs.
  const whereWithoutStatus: Prisma.UserWhereInput = {
    workspaceUsers: { some: { workspaceId: actor.workspaceId } },
    AND: [
      ...(buildEqualityFilters(
        request.query,
        USER_LIST_EQUALITY_FILTERS,
      ) as Prisma.UserWhereInput[]),
      profileId
        ? {
            userProfiles: {
              some: {
                profileId,
                workspaceId: actor.workspaceId,
                ...(manageableAppIds && { appId: { in: manageableAppIds } }),
              },
            },
          }
        : {},
      buildUserSearchFilter(search?.trim()),
    ],
  };
  const where: Prisma.UserWhereInput = {
    AND: [whereWithoutStatus, statusFilter],
  };

  const [users, totalCount, allCount, activeCount] = await Promise.all([
    prisma.user.findMany({
      where,
      select: buildUserSelect(actor.workspaceId, manageableAppIds),
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      skip: reqPageIndex * reqPageSize,
      take: reqPageSize,
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: whereWithoutStatus }),
    prisma.user.count({
      where: { AND: [whereWithoutStatus, { is_active: true }] },
    }),
  ]);

  response.json({
    rows: users.map(formatUser),
    totalCount,
    pageIndex: reqPageIndex,
    pageSize: reqPageSize,
    statusCounts: {
      All: allCount,
      Active: activeCount,
      Inactive: allCount - activeCount,
    },
  });
}

export async function getCurrentUser(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone_number: true,
      is_active: true,
      created_at: true,
      updated_at: true,
    },
  });
  if (!user) throw new ApiError(404, "User not found");

  response.json({
    user,
    workspaceId: actor.workspaceId,
    permissions: {
      isSuperAdmin: actor.isSuperAdmin,
      administeredApps: actor.administeredApps,
      permissions: actor.permissions,
    },
  });
}

export async function getUserById(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const user = await prisma.user.findFirst({
    where: {
      id: getRouteParameter(request, "id"),
      workspaceUsers: { some: { workspaceId: actor.workspaceId } },
    },
    select: buildUserSelect(actor.workspaceId, getManageableAppIds(actor)),
  });
  if (!user) throw new ApiError(404, "User not found");

  response.json(formatUser(user));
}

// New users start with no app access; an admin grants it afterwards by
// assigning a profile in an app they administer.
export async function createUser(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const { first_name, last_name, businessPartnerId } = request.body;

  if (typeof first_name !== "string" || !first_name.trim()) {
    throw new ApiError(400, "first_name is required");
  }
  if (typeof last_name !== "string" || !last_name.trim()) {
    throw new ApiError(400, "last_name is required");
  }
  if (!businessPartnerId)
    throw new ApiError(400, "businessPartnerId is required");
  await assertBusinessPartnerExists(businessPartnerId);

  const user = await prisma.user.create({
    data: {
      ...pickEditableUserFields(request.body),
      password: DEFAULT_PASSWORD,
      is_active: true,
      is_default_login: true,
      workspaceUsers: { create: { workspaceId: actor.workspaceId } },
    } as Prisma.UserUncheckedCreateInput,
    select: USER_FIELDS_SELECT,
  });

  response.status(201).json({ message: "User created successfully", user });
}

export async function updateUser(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const userId = getRouteParameter(request, "id");
  await assertWorkspaceMember(actor.workspaceId, userId);

  const fields = pickEditableUserFields(request.body);
  await assertBusinessPartnerExists(fields.businessPartnerId);

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...fields,
      updated_at: new Date(),
    } as Prisma.UserUncheckedUpdateInput,
    select: USER_FIELDS_SELECT,
  });

  response.json({ message: "User updated successfully", user });
}

export async function deactivateUser(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const userId = getRouteParameter(request, "id");
  await assertWorkspaceMember(actor.workspaceId, userId);

  const user = await prisma.user.update({
    where: { id: userId },
    data: { is_active: false, updated_at: new Date() },
    select: USER_FIELDS_SELECT,
  });

  response.json({ message: "User deactivated successfully", user });
}

// Removes the membership and everything scoped to it (profiles and admin
// rights in this workspace); the User record itself is kept.
export async function removeUserFromWorkspace(
  request: Request,
  response: Response,
) {
  const actor = getAuthenticatedUser(request);
  const userId = getRouteParameter(request, "userId");

  if (userId === actor.id) {
    throw new ApiError(400, "You cannot remove yourself from the workspace");
  }
  await assertWorkspaceMember(actor.workspaceId, userId);

  const scope = { userId, workspaceId: actor.workspaceId };
  await prisma.$transaction([
    prisma.userProfile.deleteMany({ where: scope }),
    prisma.appAdministrator.deleteMany({ where: scope }),
    prisma.workspaceUser.delete({ where: { userId_workspaceId: scope } }),
  ]);

  response.json({ message: "User removed from workspace successfully" });
}

export const getByDEmployees = respondWithODataResults(
  BYD_EMPLOYEES_URL,
  "SAP_BYD",
);
export const getC4CEmployees = respondWithODataResults(
  C4C_EMPLOYEES_URL,
  "SAP_C4C",
);

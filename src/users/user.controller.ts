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
//
// location/designation/division/costCenter are FK scalar columns
// (locationId/designationId/divisionId/costCenterId) — a plain scalar
// assignment is enough for Prisma, same as any other editable field here.
// "location" is what the old "region" column actually held — EOR's
// "Location" (plant/city) — renamed to match; see schema.prisma.
// zones is a many-to-many relation (zoneIds in the request body) and can't
// go through this generic allowlist — see pickEditableUserFields below.
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
  "locationId",
  "address",
  "branch",
  "department",
  "role",
  "designationId",
  "divisionId",
  "costCenterId",
  "vertical",
  "managerCode1",
  "managerCode2",
  "isDefaultContact",
  "userType",
  "joinedOn",
  "grade",
  "businessPartnerId",
] as const;

// location/designation/division/costCenter/zones are selected as their
// relation (not the bare FK scalar) so formatUser below can flatten each to
// its display value for every existing read-only consumer (approver
// pickers, admin lists, etc.), while still returning the *Id alongside it
// for the User admin edit form, which needs an id to preselect.
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
  locationId: true,
  location: { select: { id: true, name: true } },
  address: true,
  branch: true,
  department: true,
  role: true,
  designationId: true,
  designation: { select: { id: true, name: true } },
  divisionId: true,
  division: { select: { id: true, name: true } },
  costCenterId: true,
  costCenter: { select: { id: true, code: true, name: true } },
  zones: { select: { id: true, region_name: true } },
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

// What GET /users/me returns and PATCH /users/me echoes back. Kept narrow on
// purpose: the signed-in user only needs their own profile basics.
// designation/zones are relations now (see USER_FIELDS_SELECT above) —
// selected the same way and flattened by formatCurrentUser below, so the
// response shape (designation as a plain string) stays unchanged for
// whatever reads GET/PATCH /users/me.
const CURRENT_USER_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone_number: true,
  designationId: true,
  designation: { select: { id: true, name: true } },
  department: true,
  is_active: true,
  created_at: true,
  updated_at: true,
  zones: { select: { id: true, region_name: true } },
  branch: true,
} satisfies Prisma.UserSelect;

type CurrentUserRecord = Prisma.UserGetPayload<{
  select: typeof CURRENT_USER_SELECT;
}>;

function formatCurrentUser({ designation, zones, ...user }: CurrentUserRecord) {
  return {
    ...user,
    designation: designation?.name ?? null,
    zones: zones.map((zone) => zone.region_name),
  };
}

// Fields a user may change on their own record. Separate from
// EDITABLE_USER_FIELDS (admin edits): email, address, role, codes, etc. stay
// admin-only, so a self-update body can never write to them.
//
// designationId replaces designation now that it's a master-driven FK
// rather than free text — the caller sends the Designation row's id, same
// as the admin edit form's picker does.
const SELF_EDITABLE_USER_FIELDS = [
  "first_name",
  "last_name",
  "phone_number",
  "designationId",
  "department",
] as const;

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

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

// Flattens location/designation/division/costCenter/zones from their
// relation shape into the flat fields every existing read-only consumer
// already expects (location/designation/division/costCenter as a plain
// string, zones as a string array) — plus the *Id/zoneIds alongside them,
// which only the User admin edit form actually uses, to preselect the
// right option. This is what keeps the FK migration from rippling into
// every place that just displays a user's designation/location as text.
function formatUser({
  userProfiles,
  location,
  designation,
  division,
  costCenter,
  zones,
  ...user
}: UserWithAppAccess) {
  return {
    ...user,
    location: location?.name ?? null,
    designation: designation?.name ?? null,
    division: division?.name ?? null,
    costCenter: costCenter?.code ?? null,
    zones: zones.map((zone) => zone.region_name),
    zoneIds: zones.map((zone) => zone.id),
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

  // zoneIds is a many-to-many relation, not a plain column — Prisma needs
  // `zones: { set: [...] }`, not a scalar assignment like the fields above.
  // `set` replaces the full list, matching how every other organization
  // field here is a full overwrite on save, not a merge.
  if (Array.isArray(body.zoneIds)) {
    fields.zones = { set: (body.zoneIds as string[]).map((id) => ({ id })) };
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
    select: CURRENT_USER_SELECT,
  });
  if (!user) throw new ApiError(404, "User not found");

  response.json({
    user: formatCurrentUser(user),
    workspaceId: actor.workspaceId,
    permissions: {
      isSuperAdmin: actor.isSuperAdmin,
      administeredApps: actor.administeredApps,
      permissions: actor.permissions,
    },
  });
}

// Self-service profile edit. The id always comes from the authenticated
// actor, never from the URL or body, so a user can only ever change their
// own record.
export async function updateCurrentUser(request: Request, response: Response) {
  const actor = getAuthenticatedUser(request);
  const body = (request.body ?? {}) as Record<string, unknown>;

  const data: Record<string, string | null> = {};
  for (const field of SELF_EDITABLE_USER_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new ApiError(400, `${field} must be a string`);
    }
    data[field] = raw.trim();
  }

  if (data.first_name === "") throw new ApiError(400, "first_name is required");
  if (data.last_name === "") throw new ApiError(400, "last_name is required");

  if (data.phone_number !== undefined) {
    // phone_number is unique: an empty string would collide, null does not.
    if (data.phone_number === "") {
      data.phone_number = null;
    } else if (!INDIAN_MOBILE_REGEX.test(data.phone_number as string)) {
      throw new ApiError(
        400,
        "phone_number must be a valid 10-digit mobile number",
      );
    }
  }

  // designationId is a nullable FK scalar, not free text: an empty string
  // isn't a valid id, so clearing the field means null, same posture as
  // phone_number above.
  if (data.designationId === "") {
    data.designationId = null;
  }

  if (Object.keys(data).length === 0) {
    throw new ApiError(400, "No editable fields provided");
  }

  try {
    const user = await prisma.user.update({
      where: { id: actor.id },
      data: {
        ...data,
        updated_at: new Date(),
      } as Prisma.UserUncheckedUpdateInput,
      select: CURRENT_USER_SELECT,
    });

    response.json({
      message: "Profile updated successfully",
      user: formatCurrentUser(user),
    });
  } catch (error) {
    // Prisma unique-constraint violation (phone number used by another user).
    if ((error as { code?: string } | null)?.code === "P2002") {
      throw new ApiError(409, "This phone number is already in use");
    }
    throw error;
  }
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

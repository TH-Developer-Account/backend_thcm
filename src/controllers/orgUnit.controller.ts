import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import {
  insertClosureRowsForNewUnit,
  assertIsManagerOfUnit,
  getManagedUnitIds,
} from "../services/orgHierarchy.services";

// ─────────────────────────────────────────────────────────────────────────────
// orgUnit.controller.ts
//
// Super admin only. Manages the tree structure (nodes only — not membership).
// Tree is write-once: create and delete supported, reparenting is not.
//
// Routes (suggested):
//   POST   /org-units                  → createOrgUnit
//   GET    /org-units                  → getOrgTree
//   GET    /org-units/:unitId          → getOrgUnitById
//   DELETE /org-units/:unitId          → deleteOrgUnit
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// POST /org-units
//
// Creates an OrgUnit and wires it into the closure table.
// parentId is optional — omit for a root unit.
//
// Payload:
// {
//   "workspaceId": "uuid",
//   "name": "South Region Team",
//   "description": "...",    // optional
//   "parentId": "uuid"       // optional — null means root
// }
// ─────────────────────────────────────────────────────────────────────────────

export const createOrgUnit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { workspaceId, name, description, parentId = null } = req.body;

    if (!workspaceId) throw new ApiError(400, "workspaceId is required");
    if (!name?.trim()) throw new ApiError(400, "name is required");

    // If a parentId is given, verify it exists in the same workspace
    if (parentId !== null) {
      const parent = await prisma.orgUnit.findUnique({
        where: { id: parentId },
        select: { id: true, workspaceId: true },
      });

      if (!parent) throw new ApiError(404, "Parent org unit not found");
      if (parent.workspaceId !== workspaceId) {
        throw new ApiError(400, "Parent unit belongs to a different workspace");
      }
    }

    const unit = await prisma.$transaction(async (tx) => {
      const created = await tx.orgUnit.create({
        data: { workspaceId, name: name.trim(), description, parentId },
      });

      // Wire closure table — must happen in the same transaction
      await insertClosureRowsForNewUnit(created.id, parentId);

      return created;
    });

    res.status(201).json({
      success: true,
      message: "Org unit created successfully",
      data: unit,
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      return next(
        new ApiError(
          409,
          "An org unit with this name already exists in the workspace",
        ),
      );
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /org-units
//
// Returns the full org tree for a workspace as a flat list with parentId.
// The frontend reconstructs the tree from parentId references.
// Includes member count per unit for display.
//
// Query params:
//   workspaceId (required)
// ─────────────────────────────────────────────────────────────────────────────

export const getOrgTree = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) throw new ApiError(400, "workspaceId is required");

    const units = await prisma.orgUnit.findMany({
      where: { workspaceId: String(workspaceId) },
      select: {
        id: true,
        name: true,
        description: true,
        parentId: true,
        created_at: true,
        _count: { select: { members: true } },
        members: {
          select: {
            role: true,
            user: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: "asc" },
    });

    res.status(200).json({ success: true, data: units });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /org-units/:unitId
//
// Single unit with its direct members and immediate children.
// ─────────────────────────────────────────────────────────────────────────────

export const getOrgUnitById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { unitId } = req.params;
    if (!unitId) throw new ApiError(400, "unitId is required");

    const unit = await prisma.orgUnit.findUnique({
      where: { id: unitId as string },
      include: {
        children: {
          select: {
            id: true,
            name: true,
            _count: { select: { members: true } },
          },
        },
        members: {
          select: {
            role: true,
            user: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!unit) throw new ApiError(404, "Org unit not found");

    res.status(200).json({ success: true, data: unit });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /org-units/:unitId
//
// Deletes an OrgUnit.
// Blocked if the unit has children — you must delete leaves first.
// Blocked if the unit has members — remove them first.
//
// Closure rows cascade-delete via onDelete: Cascade on OrgUnitClosure.
//
// Why block instead of cascade-deleting children?
// Silently removing a whole subtree of people's org memberships is dangerous.
// Forcing leaf-first deletion makes the operation explicit and auditable.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteOrgUnit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { unitId } = req.params;
    if (!unitId) throw new ApiError(400, "unitId is required");

    const unit = await prisma.orgUnit.findUnique({
      where: { id: unitId as string },
      select: {
        id: true,
        name: true,
        _count: { select: { children: true, members: true } },
      },
    });

    if (!unit) throw new ApiError(404, "Org unit not found");

    if (unit._count.children > 0) {
      throw new ApiError(
        409,
        `Cannot delete "${unit.name}" — it has ${unit._count.children} child unit(s). Delete them first.`,
      );
    }

    if (unit._count.members > 0) {
      throw new ApiError(
        409,
        `Cannot delete "${unit.name}" — it has ${unit._count.members} member(s). Remove them first.`,
      );
    }

    // Closure rows cascade via DB onDelete: Cascade
    await prisma.orgUnit.delete({ where: { id: unitId as string } });

    res.status(200).json({
      success: true,
      message: `Org unit "${unit.name}" deleted successfully`,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// orgUnitMember.controller.ts
//
// Two callers with different authority levels:
//
//   Super admin  — can add/remove any workspace user to/from any unit,
//                  and can set the role (MANAGER | MEMBER).
//
//   Manager      — can add/remove members within their own unit only.
//                  Cannot change roles (role is set by super admin).
//                  Cannot add to a unit they don't manage.
//
// Routes (suggested):
//   POST   /org-units/:unitId/members          → addMember   (admin + manager)
//   DELETE /org-units/:unitId/members/:userId  → removeMember (admin + manager)
//   GET    /org-units/:unitId/members          → getMembers   (admin + manager)
//   GET    /org-units/my-team                  → getMyTeam    (any manager)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// POST /org-units/:unitId/members
//
// Adds a user to an OrgUnit.
//
// Super admin: can set role to MANAGER or MEMBER.
// Manager:     can only add MEMBER role. Cannot add to units they don't manage.
//
// Payload:
// {
//   "userId": "uuid",
//   "role": "MEMBER"   // MANAGER only settable by super admin
// }
// ─────────────────────────────────────────────────────────────────────────────

export const addMember = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const requestingUserId = req?.user?.id;
    if (!requestingUserId) throw new ApiError(401, "Unauthorized");

    const { unitId } = req.params;
    const { userId, role = "MEMBER" } = req.body;

    if (!unitId) throw new ApiError(400, "unitId is required");
    if (!userId) throw new ApiError(400, "userId is required");

    const unit = await prisma.orgUnit.findUnique({
      where: { id: unitId as string },
      select: { id: true, workspaceId: true, name: true },
    });
    if (!unit) throw new ApiError(404, "Org unit not found");

    // Check if requesting user is super admin
    const workspaceMembership = await prisma.workspaceUser.findUnique({
      where: {
        userId_workspaceId: {
          userId: requestingUserId,
          workspaceId: unit.workspaceId,
        },
      },
      select: { isSuperAdmin: true },
    });

    const isSuperAdmin = workspaceMembership?.isSuperAdmin === true;

    if (!isSuperAdmin) {
      // Manager path — enforce Q3: can only manage their own unit
      await assertIsManagerOfUnit(requestingUserId, unitId as string);

      // Managers cannot assign the MANAGER role — only super admin can
      if (role === "MANAGER") {
        throw new ApiError(
          403,
          "Only a super admin can assign the MANAGER role",
        );
      }
    }

    // Verify the target user is a workspace member
    const targetMembership = await prisma.workspaceUser.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId: unit.workspaceId },
      },
      select: { userId: true },
    });
    if (!targetMembership) {
      throw new ApiError(404, "User is not a member of this workspace");
    }

    const member = await prisma.orgUnitMember.create({
      data: { orgUnitId: unitId as string, userId, role },
      include: {
        user: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: `User added to "${unit.name}" as ${role}`,
      data: member,
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      return next(
        new ApiError(409, "User is already a member of this org unit"),
      );
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /org-units/:unitId/members/:userId
//
// Removes a user from an OrgUnit.
//
// Super admin: can remove anyone from any unit.
// Manager:     can only remove from units they manage.
//              Cannot remove themselves (the manager row) — super admin only.
// ─────────────────────────────────────────────────────────────────────────────

export const removeMember = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const requestingUserId = req?.user?.id;
    if (!requestingUserId) throw new ApiError(401, "Unauthorized");

    const { unitId, userId } = req.params;
    if (!unitId) throw new ApiError(400, "unitId is required");
    if (!userId) throw new ApiError(400, "userId is required");

    const unit = await prisma.orgUnit.findUnique({
      where: { id: unitId as string },
      select: { id: true, workspaceId: true, name: true },
    });
    if (!unit) throw new ApiError(404, "Org unit not found");

    const workspaceMembership = await prisma.workspaceUser.findUnique({
      where: {
        userId_workspaceId: {
          userId: requestingUserId,
          workspaceId: unit.workspaceId,
        },
      },
      select: { isSuperAdmin: true },
    });

    const isSuperAdmin = workspaceMembership?.isSuperAdmin === true;

    if (!isSuperAdmin) {
      await assertIsManagerOfUnit(requestingUserId, unitId as string);

      // Managers cannot remove themselves — prevents accidental self-demotion
      if (userId === requestingUserId) {
        throw new ApiError(
          403,
          "You cannot remove yourself. Contact a super admin.",
        );
      }

      // Managers cannot remove another manager — only super admin can
      const targetMembership = await prisma.orgUnitMember.findUnique({
        where: {
          orgUnitId_userId: {
            orgUnitId: unitId as string,
            userId: userId as string,
          },
        },
        select: { role: true },
      });
      if (targetMembership?.role === "MANAGER") {
        throw new ApiError(
          403,
          "Only a super admin can remove a manager from a unit",
        );
      }
    }

    await prisma.orgUnitMember.delete({
      where: {
        orgUnitId_userId: {
          orgUnitId: unitId as string,
          userId: userId as string,
        },
      },
    });

    res.status(200).json({
      success: true,
      message: "Member removed from org unit successfully",
    });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "User is not a member of this org unit"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /org-units/:unitId/members
//
// Lists all members of a unit with their roles.
// Accessible by super admin or any manager of that unit.
// ─────────────────────────────────────────────────────────────────────────────

export const getMembers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const requestingUserId = req?.user?.id;
    if (!requestingUserId) throw new ApiError(401, "Unauthorized");

    const { unitId } = req.params;
    if (!unitId) throw new ApiError(400, "unitId is required");

    const unit = await prisma.orgUnit.findUnique({
      where: { id: unitId as string },
      select: { id: true, workspaceId: true, name: true },
    });
    if (!unit) throw new ApiError(404, "Org unit not found");

    const workspaceMembership = await prisma.workspaceUser.findUnique({
      where: {
        userId_workspaceId: {
          userId: requestingUserId,
          workspaceId: unit.workspaceId,
        },
      },
      select: { isSuperAdmin: true },
    });

    const isSuperAdmin = workspaceMembership?.isSuperAdmin === true;

    if (!isSuperAdmin) {
      // Non-admin must be a manager of this specific unit to see its members
      await assertIsManagerOfUnit(requestingUserId, unitId as string);
    }

    const members = await prisma.orgUnitMember.findMany({
      where: { orgUnitId: unitId as string },
      include: {
        user: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
      },
      orderBy: { created_at: "asc" },
    });

    res.status(200).json({ success: true, data: members });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /org-units/my-team
//
// Returns all members visible to the requesting manager —
// i.e. members of every unit they manage + all descendant units.
//
// Used for the manager's "my team" dashboard view.
// ─────────────────────────────────────────────────────────────────────────────

export const getMyTeam = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req?.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const managedUnitIds = await getManagedUnitIds(userId);

    if (managedUnitIds.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // All descendant unit IDs (includes self via depth=0 rows)
    const closureRows = await prisma.orgUnitClosure.findMany({
      where: { ancestorId: { in: managedUnitIds } },
      select: { descendantId: true },
    });

    const descendantUnitIds = [
      ...new Set(closureRows.map((r) => r.descendantId)),
    ];

    const members = await prisma.orgUnitMember.findMany({
      where: { orgUnitId: { in: descendantUnitIds } },
      include: {
        user: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        orgUnit: {
          select: { id: true, name: true },
        },
      },
      orderBy: { created_at: "asc" },
    });

    res.status(200).json({ success: true, data: members });
  } catch (error) {
    next(error);
  }
};

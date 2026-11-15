import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  reconcileLiveWorkflowInstances,
  type ReconcileNotification,
} from "./workflow.helper";

type TemplateOwnerType = "ADMIN" | "USER";

type CreateTemplateInput = {
  name: string;
  description: string;
  workspaceId: string;
  metaData_1: string;
  metaData_2: string;
  metaData_3: string;
  appId: string;
  isReusable?: boolean; // defaults to true; ad-hoc callers pass false
  stages: {
    name: string;
    stageOrder: number;
    strategy: "ALL" | "ANY" | "SOME";
    minApprovals?: number;
    approverIds: { userId: string; isExternalApprover?: boolean }[];
  }[];
};

// ─────────────────────────────────────────────────────────────────────────────
// assertCanMutateTemplate
//
// Single ownership guard shared by updateTemplate and deleteTemplate, so the
// "who can touch this template" rule lives in exactly one place. An admin
// caller can mutate anything; a regular caller can only mutate a template
// they personally own (ownerType USER + created_by_id === them).
// ─────────────────────────────────────────────────────────────────────────────

export const assertCanMutateTemplate = (
  template: { ownerType: TemplateOwnerType; created_by_id: string },
  caller: { userId: string; isSuperAdmin: boolean },
) => {
  if (caller.isSuperAdmin) return;

  const isOwnUserTemplate =
    template.ownerType === "USER" && template.created_by_id === caller.userId;

  if (!isOwnUserTemplate) {
    throw new ApiError(
      403,
      "You do not have permission to modify this template",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// createWorkflowTemplate
//
// ownerType is resolved by the controller (never trust the client to say
// "I'm an admin") and passed in here. When a USER creates their own
// template, we self-assign it via WorkFlowTemplateUser in the same
// transaction — that's the only "assignment" a personal template ever
// gets, and it's what makes it show up in that user's own template list
// and in the assign/preview template lookup later.
// ─────────────────────────────────────────────────────────────────────────────

export const createWorkflowTemplate = async (
  input: CreateTemplateInput,
  userId: string,
  ownerType: TemplateOwnerType,
) => {
  return prisma.$transaction(async (tx) => {
    const template = await tx.workflowTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        workspaceId: input.workspaceId,
        created_by_id: userId,
        updated_by_id: userId,
        appId: input.appId,
        metaData_1: input.metaData_1,
        metaData_2: input.metaData_2,
        metaData_3: input.metaData_3,
        ownerType,
        isReusable: input.isReusable ?? true,

        stages: {
          create: input.stages.map((stage) => ({
            name: stage.name,
            stageOrder: stage.stageOrder,
            strategy: stage.strategy,
            minApprovals: stage.minApprovals,

            approvers: {
              create: stage.approverIds.map((user) => ({
                userId: user.userId,
                isExternalApprover: user.isExternalApprover ?? false,
              })),
            },
          })),
        },
      },
      include: {
        stages: {
          include: { approvers: true },
        },
        app: true,
      },
    });

    if (ownerType === "USER") {
      await tx.workFlowTemplateUser.create({
        data: { templateId: template.id, userId },
      });
    }

    return template;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// updateTemplate
//
// ✅ CHANGED — editing a template with active (IN_PROGRESS) workflow
// instances running on it is no longer blocked outright. What's allowed and
// what isn't:
//
//   - Add/remove approvers within an existing stage          → allowed,
//     propagated onto every live instance (see reconcileLiveWorkflowInstances
//     in workflow.helper.ts).
//   - Append a brand-new stage at the end                    → allowed, same
//     propagation — materialized fresh on every live instance.
//   - Remove an existing stage                                → still BLOCKED
//     while any instance is IN_PROGRESS. approveStage advances purely by
//     looking up `stageOrder + 1` on the live instance; removing or
//     renumbering a stageOrder that a running instance already has would
//     break that lookup for every instance on this template. Appending
//     never has this problem — existing stageOrders never move.
//
// An approval already cast (APPROVED/REJECTED/CLARIFY) is never touched,
// whatever the edit — reconcileLiveWorkflowInstances enforces that, not
// this function.
// ─────────────────────────────────────────────────────────────────────────────

export const updateTemplate = async (
  templateId: string,
  payload: any,
  caller: { userId: string; isSuperAdmin: boolean },
): Promise<{ message: string; notifications: ReconcileNotification[] }> => {
  const {
    name,
    metaData_1,
    metaData_2,
    metaData_3,
    isActive,
    isReusable, // lets a user "promote" a fork to reusable, or vice versa
    stages, // full replacement expected
    appId,
  } = payload;

  return prisma.$transaction(async (tx) => {
    // 1. Check template exists — now also loaded with its own current
    //    stages, needed below to detect a removed stageOrder.
    const existing = await tx.workflowTemplate.findUnique({
      where: { id: templateId },
      include: {
        workflowInstances: true,
        stages: { include: { approvers: true } },
      },
    });

    if (!existing) throw new ApiError(404, "Template not found");

    // 2. Ownership guard — admins can mutate anything, a regular caller only
    //    their own USER-owned templates.
    assertCanMutateTemplate(existing, caller);

    const activeInstances = existing.workflowInstances.filter(
      (w) => w.status === "IN_PROGRESS",
    );

    // 3. Stage-removal guard — see the comment above updateTemplate. Only
    //    matters when there are live instances AND the caller is sending a
    //    stage list at all; `stages` omitted entirely is a metadata-only
    //    update and never touches stages.
    if (activeInstances.length > 0 && stages) {
      const existingStageOrders = new Set(
        existing.stages.map((s) => s.stageOrder),
      );
      const nextStageOrders = new Set(stages.map((s: any) => s.stageOrder));

      const removedStageOrder = [...existingStageOrders].find(
        (order) => !nextStageOrders.has(order),
      );

      if (removedStageOrder !== undefined) {
        throw new ApiError(
          409,
          `Cannot remove stage ${removedStageOrder} — ${activeInstances.length} ` +
            "active workflow(s) are running on this template. You can add a " +
            "new stage or add/remove approvers within an existing stage, but " +
            "not remove a stage while workflows are in progress.",
        );
      }
    }

    // 4. Update basic fields
    await tx.workflowTemplate.update({
      where: { id: templateId },
      data: {
        name,
        metaData_1,
        metaData_2,
        metaData_3,
        isActive,
        ...(isReusable !== undefined && { isReusable }),
        updated_by_id: caller.userId,
        appId,
      },
    });

    if (!stages) {
      return {
        message: "Template updated (no stage change)",
        notifications: [],
      };
    }

    // 5. Delete existing stages (cascade deletes approvers). This only
    //    rewrites the TEMPLATE's own definition rows (TemplateStage /
    //    TemplateApprover) — a running WorkflowInstance's StageInstance /
    //    Approval rows are a separate, already-materialized copy and are
    //    untouched by this. Propagating onto those is step 7, below.
    await tx.templateStage.deleteMany({
      where: { templateId },
    });

    // 6. Recreate stages
    for (const stage of stages) {
      const createdStage = await tx.templateStage.create({
        data: {
          templateId,
          name: stage.name,
          stageOrder: stage.stageOrder,
          strategy: stage.strategy,
          minApprovals: stage.minApprovals,
        },
      });

      if (stage.approverIds?.length) {
        await tx.templateApprover.createMany({
          data: stage.approverIds.map(
            (approver: { userId: string; isExternalApprover?: boolean }) => ({
              stageId: createdStage.id,
              userId: approver.userId,
              isExternalApprover: approver.isExternalApprover ?? false,
            }),
          ),
        });
      }
    }

    // 7. Propagate the edit onto every live (IN_PROGRESS) instance of this
    //    template. Notifications for anyone newly added to a stage that's
    //    already running are returned here, not sent — the caller
    //    (workflowTemplate.controller.ts) sends them once this transaction
    //    has committed, same post-commit-only rule every other workflow
    //    notification in this app follows.
    const notifications = await reconcileLiveWorkflowInstances(tx, {
      templateId,
      stages: stages.map((stage: any) => ({
        stageOrder: stage.stageOrder,
        strategy: stage.strategy,
        minApprovals: stage.minApprovals ?? null,
        approverIds: (stage.approverIds ?? []).map(
          (approver: { userId: string }) => approver.userId,
        ),
      })),
    });

    return { message: "Template updated successfully", notifications };
  });
};

export const deleteTemplate = async (
  templateId: string,
  caller: { userId: string; isSuperAdmin: boolean },
) => {
  return prisma.$transaction(async (tx) => {
    const template = await tx.workflowTemplate.findUnique({
      where: { id: templateId },
      include: { workflowInstances: true },
    });

    if (!template) throw new ApiError(404, "Template not found");

    // Ownership guard — same rule as updateTemplate.
    assertCanMutateTemplate(template, caller);

    // 🚨 Critical Safety Check
    const hasRunningWorkflows = template.workflowInstances.some(
      (w) => w.status === "IN_PROGRESS",
    );

    if (hasRunningWorkflows) {
      throw new ApiError(
        409,
        "Cannot delete template with active workflows. Disable it instead.",
      );
    }

    // Optional: prevent delete if ANY historical workflows exist
    if (template.workflowInstances.length > 0) {
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: {
          isActive: false,
        },
      });
    } else {
      // Delete (cascade handles stages + approvers)
      await tx.workflowTemplate.delete({
        where: { id: templateId },
      });
    }

    return { message: "Template deleted successfully" };
  });
};

export type WorkflowListScope = "ALL" | "CREATED_BY_ME" | "ASSIGNED_TO_ME";

// ─────────────────────────────────────────────────────────────────────────────
// buildScopeFilter
//
// Single place that turns a tab selection into a Prisma where-fragment.
// Flat switch, not a registry — there are exactly 3 fixed tabs, not an
// open set keyed by subject type, so a map/registry here would be an
// abstraction with no second axis to justify it.
//
// CREATED_BY_ME  → templates this caller authored, ADMIN or USER owned.
// ASSIGNED_TO_ME → ADMIN-owned templates this caller is assigned to via
//                  WorkFlowTemplateUser (self-assigned USER templates are
//                  deliberately excluded here — those belong on "created",
//                  not "assigned").
// ALL            → union of the two above for a regular caller. Super
//                  admins keep the pre-existing behavior of seeing every
//                  template in the workspace on this tab (returns
//                  `undefined`, i.e. no extra restriction).
// ─────────────────────────────────────────────────────────────────────────────

const buildScopeFilter = (
  scope: WorkflowListScope,
  caller: { userId: string; isSuperAdmin: boolean },
): Record<string, any> | undefined => {
  const createdByMe = { created_by_id: caller.userId };
  const assignedToMe = {
    ownerType: "ADMIN" as const,
    workFlowUsers: { some: { userId: caller.userId } },
  };

  switch (scope) {
    case "CREATED_BY_ME":
      return createdByMe;
    case "ASSIGNED_TO_ME":
      return assignedToMe;
    case "ALL":
    default:
      return caller.isSuperAdmin
        ? undefined
        : { OR: [createdByMe, assignedToMe] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getTemplates
//
// Visibility rule:
//   - Admin caller (isSuperAdmin) → sees every template in the workspace,
//     same as before this change.
//   - Regular caller → only templates they're assigned to via
//     WorkFlowTemplateUser — which now covers BOTH admin-assigned templates
//     AND their own self-assigned USER templates, through the same join.
//     One query shape, no OR-branch on ownerType needed.
// ─────────────────────────────────────────────────────────────────────────────

export const getTemplates = async (
  query: any,
  caller: { userId: string; isSuperAdmin: boolean },
) => {
  const {
    workspaceId,
    isActive,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortOrder,
    scope = "ALL",
  } = query;

  const where: any = { isReusable: true };

  if (workspaceId) where.workspaceId = workspaceId;
  if (isActive !== undefined) where.isActive = isActive === "true";

  // Visibility + search both need `where.OR`/`where.AND` slots — combine
  // them into one `where.AND` array instead of letting either overwrite
  // the other.
  const andConditions: Record<string, any>[] = [];

  const scopeFilter = buildScopeFilter(scope as WorkflowListScope, caller);
  if (scopeFilter) andConditions.push(scopeFilter);

  if (search?.trim()) {
    andConditions.push({
      OR: [
        { name: { contains: search.trim(), mode: "insensitive" } },
        { description: { contains: search.trim(), mode: "insensitive" } },
      ],
    });
  }

  if (andConditions.length) where.AND = andConditions;

  // ✅ Advanced Filters
  if (filters) {
    const parsedFilters =
      typeof filters === "string" ? JSON.parse(filters) : filters;

    const { createdBy, apps } = parsedFilters;

    if (apps?.length) {
      where.appId = {
        in: Array.isArray(apps) ? apps : [apps],
      };
    }

    if (createdBy?.length) {
      where.created_by_id = {
        in: Array.isArray(createdBy) ? createdBy : [createdBy],
      };
    }
  }

  // Whitelist allowed sort fields to prevent arbitrary column injection
  const allowedSortFields = [
    "created_at",
    "updated_at",
    "name",
    "minBudget",
    "maxBudget",
  ];
  const allowedSortOrders = ["asc", "desc"];

  const resolvedSortBy = allowedSortFields.includes(sortBy)
    ? sortBy
    : "created_at";
  const resolvedSortOrder = allowedSortOrders.includes(sortOrder)
    ? sortOrder
    : "desc";

  const [data, total] = await Promise.all([
    prisma.workflowTemplate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [resolvedSortBy]: resolvedSortOrder },
      include: {
        stages: {
          orderBy: { stageOrder: "asc" },
          include: {
            approvers: {
              include: {
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
        },
        app: { select: { id: true, key: true, name: true } },
        created_by: { select: { first_name: true, last_name: true } },
        updated_by: { select: { first_name: true, last_name: true } },
        workFlowUsers: {
          include: {
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
    }),

    prisma.workflowTemplate.count({ where }),
  ]);

  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const getTemplateById = async (templateId: string) => {
  const template = await prisma.workflowTemplate.findUnique({
    where: { id: templateId },

    include: {
      workspace: {
        select: { id: true, name: true },
      },
      stages: {
        orderBy: { stageOrder: "asc" },
        include: {
          approvers: {
            include: {
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
      },
    },
  });

  if (!template) {
    throw new ApiError(404, "Template not found");
  }

  return template;
};

// ─────────────────────────────────────────────────────────────────────────────
// selectTemplate
//
// Only matches against isReusable templates — an ad-hoc, one-off
// template (isReusable: false) was scaffolding for a single run and should
// never be auto-selected for a different subject later.
// ─────────────────────────────────────────────────────────────────────────────

export const selectTemplate = async ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const templates = await prisma.workflowTemplate.findMany({
    where: {
      workspaceId,
      isActive: true,
      isReusable: true,
    },
    orderBy: {
      created_at: "desc",
    },
    include: {
      stages: {
        include: {
          approvers: true,
        },
      },
    },
  });

  if (!templates.length) {
    throw new ApiError(404, "No matching workflow template found");
  }

  return templates[0]; // highest priority
};

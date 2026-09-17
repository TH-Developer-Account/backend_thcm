import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  getActiveWorkflowForSubject,
  getCurrentStageApprovalOrThrow,
  getResubmitAction,
  getResubmitStatus,
} from "@kernel/workflow/workflowSubject.helper";
import {
  assignWorkflow,
  notifyStageApprovers,
  activateFirstStageForResubmit,
} from "@kernel/workflow/workflow.service";
import {
  Prisma,
  BusinessPartnerOfficeType,
} from "../../prisma/generated/prisma/client";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import { randomUUID } from "crypto";
import { addMailJob } from "@kernel/mail/mail.service";
import { getOrGeneratePdfUrl } from "@pdf/pdf.services";
import { assembleDealerAuditPdfData } from "./dealerAuditAssembler";

// The one place officeType gets derived from BusinessPartner — ready for
// whenever instance creation is actually written (scheduler or a manual
// admin trigger; neither exists yet, that work is still pending). Never
// trust an officeType value supplied directly in a request body for a
// dealer's own instance — it must come from their linked BusinessPartner.
export async function resolveOfficeTypeForDealer(
  dealerUserId: string,
): Promise<BusinessPartnerOfficeType> {
  const dealer = await prisma.user.findUnique({
    where: { id: dealerUserId },
    select: { businessPartner: { select: { officeType: true } } },
  });
  if (!dealer?.businessPartner) {
    throw new ApiError(
      400,
      "Dealer has no linked BusinessPartner — cannot determine office type",
    );
  }
  return dealer.businessPartner.officeType;
}

// Zone drives WorkflowTemplate selection (which reviewer chain applies) —
// a separate axis from officeType, which drives ChecklistTemplate selection
// (which checklist item set applies). Assumes the isDefault address is the
// authoritative one for zone — UNCONFIRMED, flag if isBillingAddress or
// another address should take precedence instead.
export async function resolveZoneForDealer(
  dealerUserId: string,
): Promise<string> {
  const dealer = await prisma.user.findUnique({
    where: { id: dealerUserId },
    select: {
      businessPartner: {
        select: {
          addresses: { where: { isDefault: true }, select: { zone: true } },
        },
      },
    },
  });
  const zone = dealer?.businessPartner?.addresses[0]?.zone;
  if (!zone) {
    throw new ApiError(
      400,
      "Dealer has no zone on their default BusinessPartner address — cannot select a workflow template",
    );
  }
  return zone;
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

type ItemInput = {
  order: number;
  sectionName: string;
  label: string;
  checkPoint: string;
  category?: "INFRA" | "PROCESS";
  requiresScore?: boolean;
  requiresEvidence?: boolean;
  maxScore?: number;
  scoringGuidance?: string;
};

export async function createChecklistTemplate(data: {
  name: string;
  officeType: BusinessPartnerOfficeType;
  items: ItemInput[];
}) {
  if (!data.items?.length) {
    throw new ApiError(400, "At least one item is required");
  }

  return prisma.checklistTemplate.create({
    data: {
      name: data.name,
      officeType: data.officeType,
      version: 1,
      status: "DRAFT",
      isActive: false, // a draft is never the active template for new audits
      items: { create: data.items.map((item) => ({ ...item })) },
    },
    include: { items: { orderBy: { order: "asc" } } },
  });
}

export async function listChecklistTemplates(filters: {
  officeType?: BusinessPartnerOfficeType;
  isActive?: boolean;
}) {
  return prisma.checklistTemplate.findMany({
    where: {
      officeType: filters.officeType,
      isActive: filters.isActive,
    },
    orderBy: [{ name: "asc" }, { version: "desc" }],
  });
}

export async function getChecklistTemplateById(id: string) {
  const template = await prisma.checklistTemplate.findUnique({
    where: { id },
    include: { items: { orderBy: { order: "asc" } } },
  });
  if (!template) throw new ApiError(404, "Template not found");
  return template;
}

export async function updateChecklistTemplateDraft(
  id: string,
  data: { name?: string; items?: ItemInput[] },
) {
  const template = await prisma.checklistTemplate.findUnique({
    where: { id },
  });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "DRAFT") {
    throw new ApiError(
      400,
      "Only a draft template can be edited — publish a new draft version instead",
    );
  }

  return prisma.$transaction(async (tx) => {
    if (data.items) {
      // Safe to delete-and-recreate wholesale, specifically because this
      // template is still DRAFT: nothing has snapshotted it yet (only a
      // PUBLISHED template is ever referenced by DealerAuditInstance), so
      // there's no risk of orphaning a real audit's item responses.
      await tx.checklistItem.deleteMany({ where: { templateId: id } });
      await tx.checklistTemplate.update({
        where: { id },
        data: { items: { create: data.items.map((item) => ({ ...item })) } },
      });
    }

    return tx.checklistTemplate.update({
      where: { id },
      data: { name: data.name },
      include: { items: { orderBy: { order: "asc" } } },
    });
  });
}

export async function createTemplateDraftVersion(id: string) {
  const source = await prisma.checklistTemplate.findUnique({
    where: { id },
    include: { items: { orderBy: { order: "asc" } } },
  });
  if (!source) throw new ApiError(404, "Template not found");
  if (source.status !== "PUBLISHED") {
    throw new ApiError(
      400,
      "A new draft version can only be created from a published template",
    );
  }

  return prisma.checklistTemplate.create({
    data: {
      name: source.name,
      officeType: source.officeType,
      version: source.version + 1,
      status: "DRAFT",
      isActive: false,
      items: {
        create: source.items.map((item) => ({
          order: item.order,
          sectionName: item.sectionName,
          label: item.label,
          checkPoint: item.checkPoint,
          category: item.category ?? undefined,
          requiresScore: item.requiresScore,
          requiresEvidence: item.requiresEvidence,
          maxScore: item.maxScore ?? undefined,
          scoringGuidance: item.scoringGuidance ?? undefined,
        })),
      },
    },
    include: { items: { orderBy: { order: "asc" } } },
  });
}

export async function publishChecklistTemplate(id: string) {
  const template = await prisma.checklistTemplate.findUnique({
    where: { id },
  });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "DRAFT") {
    throw new ApiError(400, "Only a draft template can be published");
  }

  return prisma.$transaction(async (tx) => {
    await tx.checklistTemplate.updateMany({
      where: {
        name: template.name,
        officeType: template.officeType,
        isActive: true,
        id: { not: id },
      },
      data: { isActive: false },
    });

    return tx.checklistTemplate.update({
      where: { id },
      data: { status: "PUBLISHED", isActive: true },
    });
  });
}

// ─────────────────────────────────────────────
// Internal staff surface: view any instance, act as reviewer
// ─────────────────────────────────────────────

// "2026-Q3" style label, computed from the current date. Only used as a
// default when the admin doesn't supply one explicitly — a manual trigger
// might legitimately be for a past quarter (catching up a dealer who was
// missed), so this is a convenience, not something forced on every call.
function getCurrentQuarterLabel(): string {
  const now = new Date();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${now.getUTCFullYear()}-Q${quarter}`;
}

// A dealer could in principle belong to more than one workspace
// (WorkspaceUser has no uniqueness on userId alone) — rather than silently
// picking one and risking the audit landing in the wrong tenant, this
// requires exactly one match and throws otherwise. Revisit if dealers
// genuinely need multi-workspace membership someday.
async function resolveWorkspaceIdForDealer(
  dealerUserId: string,
): Promise<string> {
  const memberships = await prisma.workspaceUser.findMany({
    where: { userId: dealerUserId },
    select: { workspaceId: true },
  });
  if (memberships.length !== 1) {
    throw new ApiError(
      400,
      `Expected exactly one workspace for this dealer, found ${memberships.length}`,
    );
  }
  return memberships[0].workspaceId;
}

// The manual trigger this whole function exists for — creates one
// DealerAuditInstance for a dealer, guarded by the same
// (dealerUserId, officeType, periodLabel) uniqueness the scheduler will
// rely on later. This is deliberately the ONLY place a DealerAuditInstance
// gets created, so whenever the scheduler is eventually built, it should
// call this same function rather than duplicating the resolution logic.
export async function triggerDealerAuditInstance(
  dealerUserId: string,
  periodLabel?: string,
) {
  const resolvedPeriodLabel = periodLabel ?? getCurrentQuarterLabel();
  const officeType = await resolveOfficeTypeForDealer(dealerUserId);

  const existing = await prisma.dealerAuditInstance.findUnique({
    where: {
      dealerUserId_officeType_periodLabel: {
        dealerUserId,
        officeType,
        periodLabel: resolvedPeriodLabel,
      },
    },
  });
  if (existing) {
    throw new ApiError(
      400,
      `An audit already exists for this dealer in ${resolvedPeriodLabel}`,
    );
  }

  const template = await prisma.checklistTemplate.findFirst({
    where: { officeType, isActive: true, status: "PUBLISHED" },
  });
  if (!template) {
    throw new ApiError(
      400,
      `No published, active checklist template found for ${officeType}`,
    );
  }

  const workspaceId = await resolveWorkspaceIdForDealer(dealerUserId);

  return prisma.dealerAuditInstance.create({
    data: {
      dealerUserId,
      workspaceId,
      officeType,
      periodLabel: resolvedPeriodLabel,
      checklistTemplateId: template.id,
    },
  });
}

export async function listDealerAuditInstances(filters: {
  officeType?: BusinessPartnerOfficeType;
  periodLabel?: string;
  dealerUserId?: string;
}) {
  return prisma.dealerAuditInstance.findMany({
    where: {
      officeType: filters.officeType,
      periodLabel: filters.periodLabel,
      dealerUserId: filters.dealerUserId,
    },
    include: { template: { select: { name: true, version: true } } },
    orderBy: { createdAt: "desc" },
  });
}

async function getInstanceOrThrow(id: string) {
  const instance = await prisma.dealerAuditInstance.findUnique({
    where: { id },
    include: {
      template: {
        include: { items: { orderBy: { order: "asc" } } },
      },
      responses: true,
    },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");
  return instance;
}

// Manual, reviewer-triggered — not an automatic reaction to the workflow
// reaching APPROVED. Deliberately doesn't hook into the generic engine's
// approveStage at all, unlike the reviewer-notification the engine already
// sends on its own — this is Dealer Audit's own action, living entirely in
// its own module.
export async function generateAndSendDealerAuditReport(
  reviewerUserId: string,
  instanceId: string,
  options: { ccReviewer?: boolean } = {},
) {
  // Query the workflow directly by status, not via getActiveWorkflowForSubject
  // — unsure whether isActive stays true or flips false once a workflow
  // reaches a terminal state, so this avoids relying on that assumption.
  const workflow = await prisma.workflowInstance.findFirst({
    where: {
      subjectType: "DEALER_AUDIT_INSTANCE" as never,
      subjectId: instanceId,
      status: "APPROVED",
    },
    orderBy: { created_at: "desc" },
    include: {
      stages: {
        orderBy: { stageOrder: "desc" },
        take: 1,
        include: { approvals: { where: { status: "APPROVED" } } },
      },
    },
  });
  if (!workflow) {
    throw new ApiError(
      400,
      "This audit has not been closed with an approved score yet",
    );
  }

  const reportUrl = await getOrGeneratePdfUrl(
    "DEALER_AUDIT" as never,
    instanceId,
  );

  const { dealerName, dealerEmail } =
    await assembleDealerAuditPdfData(instanceId);
  if (!dealerEmail) {
    throw new ApiError(
      400,
      "Dealer has no email on file — cannot send the report",
    );
  }

  // Defaults to true per the original "and a copy for the reviewer"
  // requirement — flip to false if that's no longer wanted now that the
  // reviewer is the one triggering this themselves.
  const ccReviewer = options.ccReviewer ?? true;
  let cc: string | undefined;
  if (ccReviewer) {
    const finalStage = workflow.stages[0];
    const approverId = finalStage?.approvals[0]?.approverId;
    if (approverId) {
      const reviewer = await prisma.user.findUnique({
        where: { id: approverId },
        select: { email: true },
      });
      cc = reviewer?.email ?? undefined;
    }
  }

  await addMailJob({
    to: dealerEmail,
    cc,
    subject: `Your Dealer Audit Report — ${dealerName}`,
    templateName: "dealer-audit-report", // .hbs template still needs creating
    templateData: { dealerName, reportUrl },
  });

  await logActivity({
    actorId: reviewerUserId,
    action: "DEALER_AUDIT_REPORT_SENT" as never,
    subjectId: instanceId,
    workflowId: workflow.id,
  });

  return { reportUrl };
}

export async function getDealerAuditInstanceById(id: string) {
  const instance = await getInstanceOrThrow(id);
  const activeWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    id,
  );
  // `responses` is full history (every round, never overwritten);
  // `currentResponses` is the one row per item that's actually live right
  // now — most consumers (scoring UI, review UI) want this, not the history.
  const currentResponses = [...pickLatestPerItem(instance.responses).values()];
  return { ...instance, currentResponses, activeWorkflow };
}

// Every function that acts on AuditItemResponse needs "the current round"
// for a given item, never "any row" — this is the one place that logic
// lives, so five call sites don't each re-derive it slightly differently.
// Every instance-level action gets an ActivityLog row — this is the one
// place that shape lives, since ActivityLog's polymorphic subjectType
// already covers DEALER_AUDIT_INSTANCE for free (no schema change needed
// beyond the ActivityAction values themselves).
async function logActivity(params: {
  actorId: string;
  action: string;
  subjectId: string;
  workflowId?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  await prisma.activityLog.create({
    data: {
      actorId: params.actorId,
      action: params.action as never,
      subjectType: "DEALER_AUDIT_INSTANCE" as never,
      subjectId: params.subjectId,
      workflowId: params.workflowId,
      metadata: params.metadata,
    },
  });
}

function pickLatestPerItem<T extends { itemId: string; iteration: number }>(
  responses: T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const response of responses) {
    const current = latest.get(response.itemId);
    if (!current || response.iteration > current.iteration) {
      latest.set(response.itemId, response);
    }
  }
  return latest;
}

function assertItemsBelongToInstance(
  instance: Awaited<ReturnType<typeof getInstanceOrThrow>>,
  itemIds: string[],
) {
  const validItemIds = new Set(instance.template.items.map((i) => i.id));
  const invalid = itemIds.find((itemId) => !validItemIds.has(itemId));
  if (invalid) {
    throw new ApiError(400, `Item ${invalid} does not belong to this instance`);
  }
}

export async function setDealerAuditReviewerNotes(
  userId: string,
  instanceId: string,
  responses: {
    itemId: string;
    reviewerScore?: number;
    reviewerRemark?: string;
  }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const instance = await getInstanceOrThrow(instanceId);
  assertItemsBelongToInstance(
    instance,
    responses.map((r) => r.itemId),
  );
  await getCurrentStageApprovalOrThrow(
    userId,
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );

  // Reviewer always acts on whichever round is current for each item, never
  // a round they pick themselves — resolve the latest iteration per item.
  // Falls back to 1 only in the edge case no dealer response exists yet
  // for that item at all.
  const latestByItem = pickLatestPerItem(instance.responses);

  await prisma.$transaction(
    responses.map((r) => {
      const iteration = latestByItem.get(r.itemId)?.iteration ?? 1;
      return prisma.auditItemResponse.upsert({
        where: {
          auditInstanceId_itemId_iteration: {
            auditInstanceId: instanceId,
            itemId: r.itemId,
            iteration,
          },
        },
        update: {
          reviewerScore: r.reviewerScore,
          reviewerRemark: r.reviewerRemark,
        },
        create: {
          auditInstanceId: instanceId,
          itemId: r.itemId,
          iteration,
          reviewerScore: r.reviewerScore,
          reviewerRemark: r.reviewerRemark,
        },
      });
    }),
  );

  await logActivity({
    actorId: userId,
    action: "DEALER_AUDIT_REVIEWER_NOTES_SET",
    subjectId: instanceId,
    metadata: { itemIds: responses.map((r) => r.itemId) },
  });
}

const REVIEWER_SETTABLE_STATUSES = new Set([
  "APPROVED",
  "CLARIFICATION_REQUESTED",
]);

export async function setDealerAuditReviewStatus(
  userId: string,
  instanceId: string,
  responses: { itemId: string; reviewStatus: string }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const invalidStatus = responses.find(
    (r) => !REVIEWER_SETTABLE_STATUSES.has(r.reviewStatus),
  );
  if (invalidStatus) {
    throw new ApiError(
      400,
      `reviewStatus must be APPROVED or CLARIFICATION_REQUESTED, got "${invalidStatus.reviewStatus}"`,
    );
  }

  const instance = await getInstanceOrThrow(instanceId);
  assertItemsBelongToInstance(
    instance,
    responses.map((r) => r.itemId),
  );
  await getCurrentStageApprovalOrThrow(
    userId,
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );

  // Reuse instance.responses (already fetched by getInstanceOrThrow) rather
  // than a second query — and resolve against the CURRENT round per item,
  // not just "any row ever," since a status decision only ever applies to
  // the round currently in front of the reviewer.
  const latestByItem = pickLatestPerItem(instance.responses);

  // Reviewer must have already recorded a score/remark on the current round
  // before deciding — setting a status with no underlying review is a
  // data-entry mistake, not a valid state.
  const missingReview = responses.find((r) => {
    const latest = latestByItem.get(r.itemId);
    return (
      !latest ||
      (latest.reviewerScore === null && latest.reviewerRemark === null)
    );
  });
  if (missingReview) {
    throw new ApiError(
      400,
      `Item ${missingReview.itemId} needs reviewer notes before its status can be set`,
    );
  }

  await prisma.$transaction(
    responses.map((r) =>
      prisma.auditItemResponse.update({
        where: {
          auditInstanceId_itemId_iteration: {
            auditInstanceId: instanceId,
            itemId: r.itemId,
            iteration: latestByItem.get(r.itemId)!.iteration,
          },
        },
        data: { reviewStatus: r.reviewStatus as never },
      }),
    ),
  );

  await logActivity({
    actorId: userId,
    action: "DEALER_AUDIT_REVIEW_STATUS_SET",
    subjectId: instanceId,
    metadata: { responses },
  });
}

// ─────────────────────────────────────────────
// Dealer surface: own instances only
// ─────────────────────────────────────────────

export async function listMyDealerAuditInstances(dealerUserId: string) {
  return prisma.dealerAuditInstance.findMany({
    where: { dealerUserId },
    include: { template: { select: { name: true, version: true } } },
    orderBy: { createdAt: "desc" },
  });
}

async function getOwnInstanceOrThrow(dealerUserId: string, instanceId: string) {
  const instance = await getInstanceOrThrow(instanceId);
  if (instance.dealerUserId !== dealerUserId) {
    throw new ApiError(403, "This audit instance does not belong to you");
  }
  return instance;
}

export async function getMyDealerAuditInstanceById(
  dealerUserId: string,
  instanceId: string,
) {
  const instance = await getOwnInstanceOrThrow(dealerUserId, instanceId);
  const activeWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );
  const currentResponses = [...pickLatestPerItem(instance.responses).values()];
  return { ...instance, currentResponses, activeWorkflow };
}

export async function saveMyDealerAuditResponses(
  dealerUserId: string,
  instanceId: string,
  responses: { itemId: string; dealerScore?: number; dealerRemark?: string }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const instance = await getOwnInstanceOrThrow(dealerUserId, instanceId);
  assertItemsBelongToInstance(
    instance,
    responses.map((r) => r.itemId),
  );

  const activeWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );
  if (activeWorkflow) {
    throw new ApiError(
      400,
      "This audit has already been submitted — use resubmit for clarification items",
    );
  }

  await prisma.$transaction(
    responses.map((r) =>
      prisma.auditItemResponse.upsert({
        // iteration: 1 is explicit and correct here, not a placeholder —
        // this function only ever runs pre-submission (guarded above by
        // the activeWorkflow check), so there's only ever one round to
        // target. Resubmission (a genuinely new round) is a separate
        // function that creates iteration + 1, never this one.
        where: {
          auditInstanceId_itemId_iteration: {
            auditInstanceId: instanceId,
            itemId: r.itemId,
            iteration: 1,
          },
        },
        update: { dealerScore: r.dealerScore, dealerRemark: r.dealerRemark },
        create: {
          auditInstanceId: instanceId,
          itemId: r.itemId,
          iteration: 1,
          dealerScore: r.dealerScore,
          dealerRemark: r.dealerRemark,
        },
      }),
    ),
  );
}

export async function submitMyDealerAuditInstance(
  dealerUserId: string,
  instanceId: string,
) {
  const instance = await getOwnInstanceOrThrow(dealerUserId, instanceId);

  const existingWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );
  if (existingWorkflow) {
    throw new ApiError(400, "This audit has already been submitted");
  }

  // Resolved by key, not hardcoded — the id itself differs per environment
  // (dev/staging/prod each get their own row from seedDealerAuditApp.ts),
  // only the key "DEALER_AUDIT" is stable across all of them.
  const app = await prisma.app.findUnique({ where: { key: "DEALER_AUDIT" } });
  if (!app) {
    throw new ApiError(
      500,
      "Dealer Audit app is not registered — run seedDealerAuditApp.ts first",
    );
  }
  const appId = app.id;

  // Zone (not officeType) is the actual workflow-template matching key —
  // which reviewer chain applies. officeType already did its job earlier,
  // selecting which ChecklistTemplate this instance snapshots.
  const zone = await resolveZoneForDealer(dealerUserId);

  const result = await prisma.$transaction((tx) =>
    assignWorkflow(tx, {
      subjectType: "DEALER_AUDIT_INSTANCE" as never,
      subjectId: instanceId,
      workspaceId: instance.workspaceId,
      appId,
      userId: dealerUserId,
      criteria: { zone },
    }),
  );

  // stageOneId can be undefined if the matched template somehow has no
  // stage 1 — guard rather than pass a possibly-undefined value into a
  // function that requires a real stageId.
  if (result.stageOneId) {
    await notifyStageApprovers({
      workflowId: result.workflowInstance.id,
      subjectType: "DEALER_AUDIT_INSTANCE" as never,
      subjectId: instanceId,
      appId,
      stageId: result.stageOneId,
      approverIds: result.stageOneApproverIds,
    });
  }

  await logActivity({
    actorId: dealerUserId,
    action: "DEALER_AUDIT_SUBMITTED",
    subjectId: instanceId,
    workflowId: result.workflowInstance.id,
  });

  return result.workflowInstance;
}

export async function resubmitMyDealerAuditInstance(
  dealerUserId: string,
  instanceId: string,
  responses: { itemId: string; dealerScore?: number; dealerRemark?: string }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const instance = await getOwnInstanceOrThrow(dealerUserId, instanceId);
  assertItemsBelongToInstance(
    instance,
    responses.map((r) => r.itemId),
  );

  // Reuse instance.responses (already fetched) rather than a second query —
  // and resolve against the latest iteration per item, not just any row,
  // same reasoning as setDealerAuditReviewStatus above.
  const latestByItem = pickLatestPerItem(instance.responses);
  const notReopened = responses.find(
    (r) =>
      latestByItem.get(r.itemId)?.reviewStatus !== "CLARIFICATION_REQUESTED",
  );
  if (notReopened) {
    throw new ApiError(
      403,
      `Item ${notReopened.itemId} is not open for resubmission`,
    );
  }

  const activeWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );
  if (!activeWorkflow) {
    throw new ApiError(
      400,
      "This audit has no active workflow to resubmit against",
    );
  }

  // A resubmission is a genuinely new round — insert a fresh row at
  // iteration + 1 rather than overwriting, so the prior round's dealer
  // score, remark, and reviewer note stay intact as history. The new
  // row's reviewerScore/reviewerRemark are left unset on purpose: carrying
  // the old reviewer note forward would let it silently linger as if it
  // still applied to content the reviewer hasn't actually seen yet.
  //
  // One transaction, not two separate calls — the items resetting to
  // PENDING and the stage actually reopening for the reviewer must
  // succeed or fail together. A dealer resubmitting with the items
  // updated but the stage never reactivated would look successful while
  // silently leaving the reviewer with nothing to act on.
  await prisma.$transaction(async (tx) => {
    await Promise.all(
      responses.map((r) =>
        tx.auditItemResponse.create({
          data: {
            auditInstanceId: instanceId,
            itemId: r.itemId,
            iteration: latestByItem.get(r.itemId)!.iteration + 1,
            dealerScore: r.dealerScore,
            dealerRemark: r.dealerRemark,
            reviewStatus: "PENDING",
          },
        }),
      ),
    );

    await activateFirstStageForResubmit(
      tx,
      activeWorkflow.id,
      { type: "user", id: dealerUserId },
      getResubmitAction("DEALER_AUDIT_INSTANCE" as never),
      getResubmitStatus("DEALER_AUDIT_INSTANCE" as never),
    );
  });

  await logActivity({
    actorId: dealerUserId,
    action: "DEALER_AUDIT_RESUBMITTED",
    subjectId: instanceId,
    workflowId: activeWorkflow.id,
    metadata: { itemIds: responses.map((r) => r.itemId) },
  });
}

export async function uploadMyDealerAuditItemEvidence(
  dealerUserId: string,
  instanceId: string,
  itemId: string,
  files: Express.Multer.File[],
  geo: { geoLat?: number; geoLng?: number },
) {
  const instance = await getOwnInstanceOrThrow(dealerUserId, instanceId);
  assertItemsBelongToInstance(instance, [itemId]);

  if (!files?.length) throw new ApiError(400, "At least one file is required");

  // Evidence attaches to a specific round, not just the item — resolve
  // (or create, if the dealer is attaching a photo before ever saving a
  // score/remark for this item) the current iteration's response row.
  // Uses pickLatestPerItem, not the hardcoded iteration:1 saveMyDealer-
  // AuditResponses uses — evidence can be uploaded on any round, not only
  // pre-submission.
  const latestByItem = pickLatestPerItem(instance.responses);
  const existingResponse = latestByItem.get(itemId);
  const response =
    existingResponse ??
    (await prisma.auditItemResponse.create({
      data: { auditInstanceId: instanceId, itemId, iteration: 1 },
    }));

  const evidence = await Promise.all(
    files.map(async (file) => {
      // Unique per upload, not overwrite-style like uploadReportImage's
      // position-keyed pattern — each round's evidence must survive
      // later rounds, same reasoning as AuditItemResponse's history.
      const s3Key = `dealer-audit-evidence/${instanceId}/${itemId}/${response.id}/${randomUUID()}-${file.originalname}`;
      await uploadToS3(s3Key, file.buffer, file.mimetype);
      // Record/display value only, per the existing uploadReportImage
      // convention — the bucket is private; actual access always goes
      // through getSignedImageUrl(s3Key) at read time, never this URL
      // directly.
      const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

      return prisma.evidence.create({
        data: {
          subjectType: "DEALER_ITEM_RESPONSE" as never,
          subjectId: response.id,
          s3Key,
          fileUrl,
          uploadedBy: dealerUserId,
          geoLat: geo.geoLat,
          geoLng: geo.geoLng,
        },
      });
    }),
  );

  await logActivity({
    actorId: dealerUserId,
    action: "DEALER_AUDIT_EVIDENCE_UPLOADED",
    subjectId: instanceId,
    metadata: { itemId, fileCount: files.length },
  });

  return evidence;
}

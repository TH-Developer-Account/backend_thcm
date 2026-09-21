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
import logger from "@shared/utils/logger";
import { runBatchJob, BatchRunSummary } from "@shared/jobs/batchRunner";

// The one place officeType gets derived from BusinessPartner. Takes the
// BusinessPartner directly, not a User — DealerAuditInstance belongs to the
// dealership, and a dealership can have several linked Users
// (BusinessPartner.users), so officeType must never be derived by walking
// through whichever User happens to be acting.
export async function resolveOfficeTypeForBusinessPartner(
  businessPartnerId: string,
): Promise<BusinessPartnerOfficeType> {
  const businessPartner = await prisma.businessPartner.findUnique({
    where: { id: businessPartnerId },
    select: { officeType: true },
  });
  if (!businessPartner) {
    throw new ApiError(400, "BusinessPartner not found");
  }
  return businessPartner.officeType;
}

// Zone drives WorkflowTemplate selection (which reviewer chain applies) —
// a separate axis from officeType, which drives ChecklistTemplate selection
// (which checklist item set applies). Assumes the isDefault address is the
// authoritative one for zone — UNCONFIRMED, flag if isBillingAddress or
// another address should take precedence instead.
export async function resolveZoneForBusinessPartner(
  businessPartnerId: string,
): Promise<string> {
  const address = await prisma.businessPartnerAddress.findFirst({
    where: { businessPartnerId, isDefault: true },
    select: { zone: true },
  });
  if (!address?.zone) {
    throw new ApiError(
      400,
      "This dealership has no zone on its default address — cannot select a workflow template",
    );
  }
  return address.zone;
}

// The one User allowed to act on a BusinessPartner's Dealer Audit instances
// (view is shared by every User linked to the dealership — see
// getOwnInstanceOrThrow — but write actions require this specific User), and
// the recipient for anything sent back to the dealership, e.g. the PDF
// report. A dealership can have several linked Users; only the one flagged
// isDefaultContact is treated as its authoritative point of contact.
async function getPrimaryContactUser(businessPartnerId: string) {
  const user = await prisma.user.findFirst({
    where: { businessPartnerId, isDefaultContact: true, is_active: true },
    select: { id: true },
  });
  if (!user) {
    throw new ApiError(
      400,
      "This dealership has no active primary contact (isDefaultContact) user — cannot proceed",
    );
  }
  return user;
}

// A dealer could in principle belong to more than one workspace
// (WorkspaceUser has no uniqueness on userId alone) — rather than silently
// picking one and risking the audit landing in the wrong tenant, this
// requires exactly one match and throws otherwise. Revisit if dealers
// genuinely need multi-workspace membership someday. Takes a User id (not a
// BusinessPartner) because workspace membership is inherently per-login —
// callers resolve the BusinessPartner's primary contact first, then pass
// that user's id in here.
async function resolveWorkspaceIdForUser(userId: string): Promise<string> {
  const memberships = await prisma.workspaceUser.findMany({
    where: { userId },
    select: { workspaceId: true },
  });
  if (memberships.length !== 1) {
    throw new ApiError(
      400,
      `Expected exactly one workspace for this user, found ${memberships.length}`,
    );
  }
  return memberships[0].workspaceId;
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

// Shared by the manual trigger and the scheduler — the scheduler needs to
// tell "already exists, skip quietly" apart from a real failure, which a
// try/catch around triggerDealerAuditInstance can't do without matching on
// error message text. Single source of truth for the duplicate check either
// way.
async function findExistingDealerAuditInstance(
  businessPartnerId: string,
  officeType: BusinessPartnerOfficeType,
  periodLabel: string,
) {
  return prisma.dealerAuditInstance.findUnique({
    where: {
      businessPartnerId_officeType_periodLabel: {
        businessPartnerId,
        officeType,
        periodLabel,
      },
    },
  });
}

// The manual trigger this whole function exists for — creates one
// DealerAuditInstance for a dealership, guarded by the same
// (businessPartnerId, officeType, periodLabel) uniqueness the scheduler
// relies on. This is deliberately the ONLY place a DealerAuditInstance gets
// created — the scheduler calls this same function rather than duplicating
// the resolution logic. workspaceId is still resolved off a User (the
// dealership's primary contact), since workspace membership is inherently
// per-login, not per-dealership.
export async function triggerDealerAuditInstance(
  businessPartnerId: string,
  periodLabel?: string,
) {
  const resolvedPeriodLabel = periodLabel ?? getCurrentQuarterLabel();
  const officeType =
    await resolveOfficeTypeForBusinessPartner(businessPartnerId);

  const existing = await findExistingDealerAuditInstance(
    businessPartnerId,
    officeType,
    resolvedPeriodLabel,
  );
  if (existing) {
    throw new ApiError(
      400,
      `An audit already exists for this dealership in ${resolvedPeriodLabel}`,
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

  const primaryContact = await getPrimaryContactUser(businessPartnerId);
  const workspaceId = await resolveWorkspaceIdForUser(primaryContact.id);

  return prisma.dealerAuditInstance.create({
    data: {
      businessPartnerId,
      workspaceId,
      officeType,
      periodLabel: resolvedPeriodLabel,
      checklistTemplateId: template.id,
    },
  });
}

// "DEALER" per the inline comment on User.userType ("reuses the existing
// THCM/DEALER/CUSTOMER enum"). Named as a constant, not inlined, so a wrong
// guess is a one-line fix rather than a hunt through the query below.
const DEALER_USER_TYPE = "DEALER";

export type QuarterlyDealerAuditGenerationSummary = BatchRunSummary & {
  periodLabel: string;
};

// The scheduler's entry point (called quarterly — see jobs/scheduler.ts).
// Also safe to call manually for a specific quarter, e.g. to catch up a
// quarter that was missed.
//
// Population is BusinessPartners, not Users — a dealership can have several
// linked Users, and the instance belongs to the dealership (see
// DealerAuditInstance.businessPartnerId), so iterating Users would create
// one instance per login instead of one per dealership. A qualifying
// dealership: active, AND has at least one active User with
// userType === "DEALER" linked to it (the population signal originally
// lived on the User; a dealership only counts once it actually has one).
// A dealership with no isDefaultContact User will still fail inside
// triggerDealerAuditInstance (via getPrimaryContactUser) — surfaced as a
// per-item failure below, not pre-filtered out, since that's a real gap
// worth seeing in the summary rather than silently skipping.
//
// The fan-out/tally mechanics (loop, catch-per-item, summary) live in the
// shared runBatchJob — Factory Audit's equivalent generator will use the
// same helper around its own population query and creation call. "Already
// has an instance this quarter" is checked up front per item and reported
// as "skipped", not "failed" — that's expected steady-state noise on a
// re-run, not an error.
export async function generateQuarterlyDealerAuditInstances(
  periodLabel?: string,
): Promise<QuarterlyDealerAuditGenerationSummary> {
  const resolvedPeriodLabel = periodLabel ?? getCurrentQuarterLabel();

  const dealerships = await prisma.businessPartner.findMany({
    where: {
      isActive: true,
      users: { some: { userType: DEALER_USER_TYPE, is_active: true } },
    },
    select: { id: true },
  });

  const batchSummary = await runBatchJob(
    dealerships,
    (dealership) => dealership.id,
    async (dealership) => {
      const officeType = await resolveOfficeTypeForBusinessPartner(
        dealership.id,
      );
      const existing = await findExistingDealerAuditInstance(
        dealership.id,
        officeType,
        resolvedPeriodLabel,
      );
      if (existing) return "skipped";

      await triggerDealerAuditInstance(dealership.id, resolvedPeriodLabel);
      return "created";
    },
  );

  const summary: QuarterlyDealerAuditGenerationSummary = {
    ...batchSummary,
    periodLabel: resolvedPeriodLabel,
  };

  logger.info(
    `Quarterly dealer audit generation (${resolvedPeriodLabel}): ` +
      `${summary.succeeded} created, ${summary.skipped} skipped (existing), ` +
      `${summary.failed} failed out of ${summary.attempted} dealerships`,
    summary.failed > 0 ? { failures: summary.failures } : undefined,
  );

  return summary;
}

export async function listDealerAuditInstances(filters: {
  officeType?: BusinessPartnerOfficeType;
  periodLabel?: string;
  businessPartnerId?: string;
}) {
  return prisma.dealerAuditInstance.findMany({
    where: {
      officeType: filters.officeType,
      periodLabel: filters.periodLabel,
      businessPartnerId: filters.businessPartnerId,
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

export async function listMyDealerAuditInstances(actingUserId: string) {
  const actingUser = await getActingDealerUserOrThrow(actingUserId);
  return prisma.dealerAuditInstance.findMany({
    where: { businessPartnerId: actingUser.businessPartnerId },
    include: { template: { select: { name: true, version: true } } },
    orderBy: { createdAt: "desc" },
  });
}

// A dealership's linked Users all share the same set of instances — a
// dealership can have several logged-in Users, and view access isn't
// restricted to just the primary contact (only writes are — see
// getOwnInstanceForEditOrThrow). Not exported: every "mine" function below
// funnels through this and its edit-checking counterpart, so req.user.id →
// businessPartnerId resolution and the ownership comparison live in exactly
// one place.
async function getActingDealerUserOrThrow(actingUserId: string) {
  const actingUser = await prisma.user.findUnique({
    where: { id: actingUserId },
    select: { businessPartnerId: true, isDefaultContact: true },
  });
  if (!actingUser?.businessPartnerId) {
    throw new ApiError(403, "You are not linked to a dealership");
  }
  return actingUser as { businessPartnerId: string; isDefaultContact: boolean };
}

async function resolveOwnInstanceAndActor(
  actingUserId: string,
  instanceId: string,
) {
  const instance = await getInstanceOrThrow(instanceId);
  const actingUser = await getActingDealerUserOrThrow(actingUserId);
  if (actingUser.businessPartnerId !== instance.businessPartnerId) {
    throw new ApiError(
      403,
      "This audit instance does not belong to your dealership",
    );
  }
  return { instance, actingUser };
}

async function getOwnInstanceOrThrow(actingUserId: string, instanceId: string) {
  const { instance } = await resolveOwnInstanceAndActor(
    actingUserId,
    instanceId,
  );
  return instance;
}

// Stricter than getOwnInstanceOrThrow — view access is shared by every User
// linked to the dealership, but only the designated primary contact
// (User.isDefaultContact) may actually change anything on the instance.
async function getOwnInstanceForEditOrThrow(
  actingUserId: string,
  instanceId: string,
) {
  const { instance, actingUser } = await resolveOwnInstanceAndActor(
    actingUserId,
    instanceId,
  );
  if (!actingUser.isDefaultContact) {
    throw new ApiError(
      403,
      "Only your dealership's primary contact can act on this audit instance",
    );
  }
  return instance;
}

export async function getMyDealerAuditInstanceById(
  actingUserId: string,
  instanceId: string,
) {
  const instance = await getOwnInstanceOrThrow(actingUserId, instanceId);
  const activeWorkflow = await getActiveWorkflowForSubject(
    "DEALER_AUDIT_INSTANCE" as never,
    instanceId,
  );
  const currentResponses = [...pickLatestPerItem(instance.responses).values()];
  return { ...instance, currentResponses, activeWorkflow };
}

export async function saveMyDealerAuditResponses(
  actingUserId: string,
  instanceId: string,
  responses: { itemId: string; dealerScore?: number; dealerRemark?: string }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const instance = await getOwnInstanceForEditOrThrow(actingUserId, instanceId);
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
        update: {
          dealerScore: r.dealerScore,
          dealerRemark: r.dealerRemark,
          respondedByUserId: actingUserId,
        },
        create: {
          auditInstanceId: instanceId,
          itemId: r.itemId,
          iteration: 1,
          dealerScore: r.dealerScore,
          dealerRemark: r.dealerRemark,
          respondedByUserId: actingUserId,
        },
      }),
    ),
  );
}

export async function submitMyDealerAuditInstance(
  actingUserId: string,
  instanceId: string,
) {
  const instance = await getOwnInstanceForEditOrThrow(actingUserId, instanceId);

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
  const zone = await resolveZoneForBusinessPartner(instance.businessPartnerId);

  const result = await prisma.$transaction((tx) =>
    assignWorkflow(tx, {
      subjectType: "DEALER_AUDIT_INSTANCE" as never,
      subjectId: instanceId,
      workspaceId: instance.workspaceId,
      appId,
      // The actual person submitting, not the dealership — assignWorkflow's
      // userId is an actor reference into the User table (who to show as
      // having submitted), unrelated to which BusinessPartner owns the
      // instance.
      userId: actingUserId,
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
    actorId: actingUserId,
    action: "DEALER_AUDIT_SUBMITTED",
    subjectId: instanceId,
    workflowId: result.workflowInstance.id,
  });

  return result.workflowInstance;
}

export async function resubmitMyDealerAuditInstance(
  actingUserId: string,
  instanceId: string,
  responses: { itemId: string; dealerScore?: number; dealerRemark?: string }[],
) {
  if (!responses?.length)
    throw new ApiError(400, "At least one response is required");

  const instance = await getOwnInstanceForEditOrThrow(actingUserId, instanceId);
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
            respondedByUserId: actingUserId,
          },
        }),
      ),
    );

    await activateFirstStageForResubmit(
      tx,
      activeWorkflow.id,
      { type: "user", id: actingUserId },
      getResubmitAction("DEALER_AUDIT_INSTANCE" as never),
      getResubmitStatus("DEALER_AUDIT_INSTANCE" as never),
    );
  });

  await logActivity({
    actorId: actingUserId,
    action: "DEALER_AUDIT_RESUBMITTED",
    subjectId: instanceId,
    workflowId: activeWorkflow.id,
    metadata: { itemIds: responses.map((r) => r.itemId) },
  });
}

export async function uploadMyDealerAuditItemEvidence(
  actingUserId: string,
  instanceId: string,
  itemId: string,
  files: Express.Multer.File[],
  geo: { geoLat?: number; geoLng?: number },
) {
  const instance = await getOwnInstanceForEditOrThrow(actingUserId, instanceId);
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
      data: {
        auditInstanceId: instanceId,
        itemId,
        iteration: 1,
        respondedByUserId: actingUserId,
      },
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
          uploadedBy: actingUserId,
          geoLat: geo.geoLat,
          geoLng: geo.geoLng,
        },
      });
    }),
  );

  await logActivity({
    actorId: actingUserId,
    action: "DEALER_AUDIT_EVIDENCE_UPLOADED",
    subjectId: instanceId,
    metadata: { itemId, fileCount: files.length },
  });

  return evidence;
}

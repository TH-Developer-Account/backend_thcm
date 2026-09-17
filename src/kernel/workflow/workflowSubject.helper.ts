// src/helpers/workflowSubject.helper.ts
//
// WorkflowInstance and ActivityLog are generic — they route/log against a
// `subjectType` + `subjectId` pair rather than an app-specific foreign key
// (e.g. eventProposalId). This file is the single place that knows how to
// turn that pair back into a real row.
//
// Why a strategy map instead of a switch statement:
//   Adding a new app's subject type means adding one entry below — no
//   existing branch is touched, no existing call site changes. A switch
//   statement buries that same addition inside conditional logic that
//   grows with every app.
//
// Why two functions instead of one:
//   Most call sites (ownership guards, "does this even exist" checks)
//   only need a single field and shouldn't pay for a full include. The
//   few read endpoints that need the hydrated object call the other one.
//   Collapsing both into one "fetch everything" function would force
//   every guard clause to over-fetch.

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { activeWorkflowInclude } from "@shared/utils/contants";
import { notifyGuestOfClarification } from "@medi-claim/mediclaim.helper";

import {
  Prisma,
  WorkflowSubjectType,
  ActivityAction,
} from "../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// getSubjectOwnerId
//
// Returns just the owning user id for a subject — the field every
// ownership/permission guard actually needs. Cheap `select`, no relations.
//
// EVENT_PROPOSAL          → EventProposal.created_by_id
// DEALER_AUDIT_INSTANCE   → DealerAuditInstance.dealerUserId
// FACTORY_AUDIT_INSTANCE  → FactoryAuditInstance.createdByUserId — the vendor
//   (Supplier) being audited has no User/login of its own, so there's no
//   natural single "owner" the way EVENT_PROPOSAL/VENDOR_ONBOARDING have one.
//   The Admin/QA Head who scheduled the audit fills this role instead. Real
//   Factory Audit access control is role/assignment-based (AuditAssignment,
//   Profile), not ownership-based — this resolver exists purely so a generic
//   ownership guard never silently 404s if it's ever called against this
//   subject type, not because "created it" is the actual permission model.
// ─────────────────────────────────────────────────────────────────────────────

const ownerIdResolvers: Record<
  WorkflowSubjectType,
  (subjectId: string) => Promise<string | null>
> = {
  EVENT_PROPOSAL: async (subjectId) => {
    const epc = await prisma.eventProposal.findUnique({
      where: { id: subjectId },
      select: { created_by_id: true },
    });
    return epc?.created_by_id ?? null;
  },
  VENDOR_ONBOARDING: async (subjectId) => {
    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: subjectId },
      select: { initiatedById: true },
    });
    return onboarding?.initiatedById ?? null;
  },

  MEDICAL_CLAIM: async (subjectId) => {
    const claim = await prisma.medicalClaim.findUnique({
      where: { id: subjectId },
      select: { initiatedById: true },
    });
    return claim?.initiatedById ?? null;
  },

  DEALER_AUDIT_INSTANCE: async (subjectId) => {
    const audit = await prisma.dealerAuditInstance.findUnique({
      where: { id: subjectId },
      select: { dealerUserId: true },
    });
    return audit?.dealerUserId ?? null;
  },

  FACTORY_AUDIT_INSTANCE: async (subjectId) => {
    const audit = await prisma.factoryAuditInstance.findUnique({
      where: { id: subjectId },
      select: { createdByUserId: true },
    });
    return audit?.createdByUserId ?? null;
  },
};

export async function getSubjectOwnerId(
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<string> {
  const resolver = ownerIdResolvers[subjectType];
  if (!resolver) {
    throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
  }

  const ownerId = await resolver(subjectId);
  if (!ownerId) {
    throw new ApiError(404, `${subjectType} not found for id "${subjectId}"`);
  }

  return ownerId;
}

// ─────────────────────────────────────────────────────────────────────────────
// findSubjectById
//
// Returns the full subject record, loosely typed. Used by read endpoints
// that flatten the subject + its active workflow into one response, the
// way getEventProposalById does today.
//
// Loosely typed by design (Promise<Record<string, unknown> | null>) per
// the generic-version decision — callers that need compile-time field
// access should narrow with the subjectType they already know they asked
// for, rather than this helper carrying per-app return-type overloads.
// ─────────────────────────────────────────────────────────────────────────────

const subjectResolvers: Record<
  WorkflowSubjectType,
  (subjectId: string) => Promise<Record<string, unknown> | null>
> = {
  EVENT_PROPOSAL: (subjectId) =>
    prisma.eventProposal.findUnique({ where: { id: subjectId } }),

  VENDOR_ONBOARDING: (subjectId) =>
    prisma.vendorOnboarding.findUnique({ where: { id: subjectId } }),

  MEDICAL_CLAIM: (subjectId) =>
    prisma.medicalClaim.findUnique({ where: { id: subjectId } }),

  DEALER_AUDIT_INSTANCE: (subjectId) =>
    prisma.dealerAuditInstance.findUnique({ where: { id: subjectId } }),

  FACTORY_AUDIT_INSTANCE: (subjectId) =>
    prisma.factoryAuditInstance.findUnique({ where: { id: subjectId } }),
};

export async function findSubjectById(
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<Record<string, unknown>> {
  const resolver = subjectResolvers[subjectType];
  if (!resolver) {
    throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
  }

  const subject = await resolver(subjectId);
  if (!subject) {
    throw new ApiError(404, `${subjectType} not found for id "${subjectId}"`);
  }

  return subject;
}

export async function getActiveWorkflowForSubject(
  subjectType: WorkflowSubjectType,
  subjectId: string,
) {
  return prisma.workflowInstance.findFirst({
    where: { subjectType, subjectId, isActive: true },
    orderBy: { created_at: "desc" },
    include: activeWorkflowInclude,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// updateSubjectStatus
//
// The third thing this file needs to know about each subject type: how to
// write its status back. Used by approveStage (final stage), rejectStage,
// and clarifyStage — the only thing that varies per call site is which
// status string gets passed in.
//
// DEALER_AUDIT_INSTANCE and FACTORY_AUDIT_INSTANCE are both deliberate
// no-ops: neither model has a stored status column — lifecycle for both is
// read off their linked WorkflowInstance(s), same reasoning documented for
// the old commented-out AUDIT_INSTANCE branch this replaces.
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

const statusUpdaters: Record<
  WorkflowSubjectType,
  (tx: Tx, subjectId: string, status: string) => Promise<unknown>
> = {
  EVENT_PROPOSAL: (tx, subjectId, status) =>
    tx.eventProposal.update({ where: { id: subjectId }, data: { status } }),

  VENDOR_ONBOARDING: (tx, subjectId, status) =>
    tx.vendorOnboarding.update({ where: { id: subjectId }, data: { status } }),

  MEDICAL_CLAIM: (tx, subjectId, status) =>
    tx.medicalClaim.update({ where: { id: subjectId }, data: { status } }),

  DEALER_AUDIT_INSTANCE: async () => undefined,
  FACTORY_AUDIT_INSTANCE: async () => undefined,
};

export async function updateSubjectStatus(
  tx: Tx,
  subjectType: WorkflowSubjectType,
  subjectId: string,
  status: string,
): Promise<void> {
  const updater = statusUpdaters[subjectType];
  if (!updater) return; // unwired subject type — no-op, same as commented-out AUDIT_INSTANCE branches above
  await updater(tx, subjectId, status);
}

// ─────────────────────────────────────────────────────────────────────────────
// clarifyResetStatus
//
// Clarify doesn't reuse a pass-through status like APPROVED/REJECTED — each
// subject resets to a different "who does this go back to" status.
// EVENT_PROPOSAL → PENDING (back to proposer)
// VENDOR_ONBOARDING → IN_REVIEW (back to initiating employee, not the vendor)
//
// DEALER_AUDIT_INSTANCE: real, but NOT the whole-subject reopen mediclaim
// uses. Dealer Audit's own confirmed rule is that only flagged items reopen
// on clarify — approved items stay locked. That selective locking lives on
// AuditItemResponse.reviewStatus in Dealer Audit's own domain code, not
// here. This entry only satisfies what the generic engine itself needs
// (what string to reset the subject to) — it does not, by itself, implement
// the per-item lock/unlock behavior. Don't assume this one value is the
// whole story for Dealer Audit's clarify flow.
//
// FACTORY_AUDIT_INSTANCE: UNVERIFIED PLACEHOLDER. The classification
// approval chain (sequential, admin-configured, named approvers) is
// approve-only for now by explicit product decision — Reject/Clarify
// semantics for this chain haven't been defined with the client yet, and
// Reject/Clarify should be hidden in the UI for this specific chain's
// stages until that lands. This value exists only so the Record type
// compiles; it is not a confirmed business decision. If this code path is
// ever actually reached for FACTORY_AUDIT_INSTANCE, treat that as a bug —
// the UI gate should have prevented it.
// ─────────────────────────────────────────────────────────────────────────────

const clarifyResetStatus: Record<WorkflowSubjectType, string> = {
  EVENT_PROPOSAL: "PENDING",
  VENDOR_ONBOARDING: "IN_REVIEW",
  MEDICAL_CLAIM: "CLARIFICATION_REQUESTED",
  DEALER_AUDIT_INSTANCE: "PENDING",
  FACTORY_AUDIT_INSTANCE: "PENDING", // UNVERIFIED — see comment above
};

export function getClarifyResetStatus(
  subjectType: WorkflowSubjectType,
): string {
  return clarifyResetStatus[subjectType] ?? "PENDING";
}

const postClarifyHooks: Partial<
  Record<WorkflowSubjectType, (tx: Tx, subjectId: string) => Promise<void>>
> = {
  MEDICAL_CLAIM: (tx, subjectId) => notifyGuestOfClarification(tx, subjectId),
};

export async function runPostClarifyHook(
  tx: Tx,
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<void> {
  const hook = postClarifyHooks[subjectType];
  if (hook) await hook(tx, subjectId);
}

// ─────────────────────────────────────────────────────────────────────────────
// preApprovalValidators / runPreApprovalValidation
//
// The mirror-image hook to postClarifyHooks: instead of "something to run
// after a clarify," this is "something to check before an approve is
// allowed to go through." Needed because DEALER_AUDIT_INSTANCE has a real
// precondition mediclaim never needed — the final approve is only valid
// once every item on the audit has an individual reviewStatus of APPROVED.
// Without this, approveStage would let a reviewer approve the whole audit
// while items are still PENDING or CLARIFICATION_REQUESTED.
//
// Called from workflow.service.ts's approveStage, right after it fetches
// `stage` (which already includes `stage.workflow`), before the
// isStageApproved switch runs:
//
//   await runPreApprovalValidation(stage!.workflow.subjectType, stage!.workflow.subjectId);
//
// Partial, not a full Record — most subject types (EVENT_PROPOSAL,
// VENDOR_ONBOARDING, MEDICAL_CLAIM) have no such precondition and simply
// have no entry here, same as postClarifyHooks.
// ─────────────────────────────────────────────────────────────────────────────

const preApprovalValidators: Partial<
  Record<WorkflowSubjectType, (subjectId: string) => Promise<void>>
> = {
  DEALER_AUDIT_INSTANCE: async (subjectId) => {
    // AuditItemResponse keeps one row per round now (never overwritten),
    // so a flat count of reviewStatus != APPROVED would wrongly include
    // old, already-superseded rounds forever. Only the latest iteration
    // per item reflects current state — mirrors dealerAudit.service.ts's
    // pickLatestPerItem; duplicated here rather than imported, since this
    // shared kernel file shouldn't depend on a specific app's module.
    const responses = await prisma.auditItemResponse.findMany({
      where: { auditInstanceId: subjectId },
      select: { itemId: true, iteration: true, reviewStatus: true },
    });
    const latestByItem = new Map<string, (typeof responses)[number]>();
    for (const response of responses) {
      const current = latestByItem.get(response.itemId);
      if (!current || response.iteration > current.iteration) {
        latestByItem.set(response.itemId, response);
      }
    }
    const unresolved = [...latestByItem.values()].filter(
      (r) => r.reviewStatus !== "APPROVED",
    ).length;
    if (unresolved > 0) {
      throw new ApiError(
        400,
        `${unresolved} item(s) still need a review decision before this can be approved`,
      );
    }
  },
};

export async function runPreApprovalValidation(
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<void> {
  const validator = preApprovalValidators[subjectType];
  if (validator) await validator(subjectId);
}

// Subject-specific action name + status for the "resubmitted" transition —
// same reasoning as clarifyResetStatus. Without this, every subject type
// resubmitting through activateFirstStageController would get EPC's
// action name/status literal, which is wrong the moment a second subject
// type uses the endpoint (as MEDICAL_CLAIM now does).
//
// FACTORY_AUDIT_INSTANCE's action is a genuine UNVERIFIED PLACEHOLDER value —
// approve-only chain, resubmit path unused until Reject/Clarify semantics
// are defined. DEALER_AUDIT_INSTANCE's is real and correct.
const resubmitActionBySubjectType: Record<WorkflowSubjectType, ActivityAction> =
  {
    EVENT_PROPOSAL: "EPC_RESUBMITTED",
    VENDOR_ONBOARDING: "VENDOR_FORM_SUBMITTED",
    MEDICAL_CLAIM: "MEDICAL_CLAIM_RESUBMITTED",
    DEALER_AUDIT_INSTANCE: "DEALER_AUDIT_RESUBMITTED",
    FACTORY_AUDIT_INSTANCE: "FACTORY_AUDIT_RESUBMITTED",
  };

const resubmitStatusBySubjectType: Record<WorkflowSubjectType, string> = {
  EVENT_PROPOSAL: "Resubmitted",
  VENDOR_ONBOARDING: "IN_PROGRESS",
  MEDICAL_CLAIM: "IN_PROGRESS",
  DEALER_AUDIT_INSTANCE: "IN_PROGRESS",
  FACTORY_AUDIT_INSTANCE: "IN_PROGRESS", // UNVERIFIED — see note above
};

export function getResubmitAction(
  subjectType: WorkflowSubjectType,
): ActivityAction {
  return resubmitActionBySubjectType[subjectType];
}

export function getResubmitStatus(subjectType: WorkflowSubjectType): string {
  return resubmitStatusBySubjectType[subjectType];
}

// workflowSubject.helper.ts — new export
export async function getCurrentStageApprovalOrThrow(
  userId: string,
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<{ workflowInstanceId: string; stageId: string }> {
  const activeWorkflow = await prisma.workflowInstance.findFirst({
    where: { subjectType, subjectId, isActive: true },
    select: { id: true },
  });
  if (!activeWorkflow) {
    throw new ApiError(404, "No active workflow found for this record");
  }

  const approval = await prisma.approval.findFirst({
    where: {
      approverId: userId,
      isExternalApprover: false,
      stage: {
        workflowId: activeWorkflow.id,
        isCurrentIteration: true,
        status: "IN_PROGRESS",
      },
    },
    select: { stageId: true },
  });
  if (!approval) {
    throw new ApiError(
      403,
      "You are not authorized to act on this record's current stage",
    );
  }

  return { workflowInstanceId: activeWorkflow.id, stageId: approval.stageId };
}

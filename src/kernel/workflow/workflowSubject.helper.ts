// src/helpers/workflowSubject.helper.ts
//
// WorkflowInstance and ActivityLog are generic — they route/log against a
// `subjectType`   `subjectId` pair rather than an app-specific foreign key
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
import { notifyGuestOfClarification } from "@modules/mediclaim/mediclaim.helper";

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
// EVENT_PROPOSAL → EventProposal.created_by_id
// AUDIT_INSTANCE  → AuditInstance.dealerUserId
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
// that flatten the subject   its active workflow into one response, the
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
// updateSubjectStatus  ✅ NEW
//
// The third thing this file needs to know about each subject type: how to
// write its status back. Used by approveStage (final stage), rejectStage,
// and clarifyStage — the only thing that varies per call site is which
// status string gets passed in.
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
// clarifyResetStatus  ✅ NEW
//
// Clarify doesn't reuse a pass-through status like APPROVED/REJECTED — each
// subject resets to a different "who does this go back to" status.
// EVENT_PROPOSAL → PENDING (back to proposer)
// VENDOR_ONBOARDING → IN_REVIEW (back to initiating employee, not the vendor)
// ─────────────────────────────────────────────────────────────────────────────

const clarifyResetStatus: Record<WorkflowSubjectType, string> = {
  EVENT_PROPOSAL: "PENDING",
  VENDOR_ONBOARDING: "IN_REVIEW",
  MEDICAL_CLAIM: "CLARIFICATION_REQUESTED",
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

// Subject-specific action name + status for the "resubmitted" transition —
// same reasoning as clarifyResetStatus. Without this, every subject type
// resubmitting through activateFirstStageController would get EPC's
// action name/status literal, which is wrong the moment a second subject
// type uses the endpoint (as MEDICAL_CLAIM now does).
const resubmitActionBySubjectType: Record<WorkflowSubjectType, ActivityAction> =
  {
    EVENT_PROPOSAL: "EPC_RESUBMITTED",
    VENDOR_ONBOARDING: "VENDOR_FORM_SUBMITTED",
    MEDICAL_CLAIM: "MEDICAL_CLAIM_RESUBMITTED",
  };

const resubmitStatusBySubjectType: Record<WorkflowSubjectType, string> = {
  EVENT_PROPOSAL: "Resubmitted",
  VENDOR_ONBOARDING: "IN_PROGRESS",
  MEDICAL_CLAIM: "IN_PROGRESS",
};

export function getResubmitAction(
  subjectType: WorkflowSubjectType,
): ActivityAction {
  return resubmitActionBySubjectType[subjectType];
}

export function getResubmitStatus(subjectType: WorkflowSubjectType): string {
  return resubmitStatusBySubjectType[subjectType];
}

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

import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { activeWorkflowInclude } from "../utils/contants";

// export type WorkflowSubjectType = "EVENT_PROPOSAL" | "AUDIT_INSTANCE";
export type WorkflowSubjectType = "EVENT_PROPOSAL";

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

  // AUDIT_INSTANCE: async (subjectId) => {
  //   const audit = await prisma.auditInstance.findUnique({
  //     where: { id: subjectId },
  //     select: { dealerUserId: true },
  //   });
  //   return audit?.dealerUserId ?? null;
  // },
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

  // AUDIT_INSTANCE: (subjectId) =>
  //   prisma.auditInstance.findUnique({ where: { id: subjectId } }),
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

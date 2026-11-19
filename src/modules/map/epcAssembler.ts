import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { activeWorkflowInclude } from "@shared/utils/contants";

// ─────────────────────────────────────────────────────────────────────────────
// EPC — PDF DATA ASSEMBLER
//
// Single responsibility: fetch the EventProposal record + its EPF/CRF
// children + its active workflow + comments + activity log, and shape them
// into the flat structure the docDefinition builder expects. Knows nothing
// about pdfmake, S3, or rendering. Mirrors vendorOnboardingAssembler.ts /
// mediclaimAssembler.ts.
//
// Self-contained by design (not extracted from comment.controller.ts):
// the comment/activity-log gathering here is scoped to a single active
// workflow instance, whereas comment.controller.ts's version spans every
// workflow instance ever created for the subject — different query shape,
// so sharing would mean threading a "which instances" parameter through
// working code for a one-off caller. Revisit if a third caller appears.
// ─────────────────────────────────────────────────────────────────────────────

export interface EpcPdfData {
  epc: {
    proposalNumber: string;
    eventName: string | null;
    eventFromDate: Date;
    eventToDate: Date;
    eventDescription: string;
    location: string;
    eventObjective: string;
    status: string;
    department: string | null;
    vertical: string | null;
    region: string | null;
    branch: string | null;
    budgetMaster: number | null;
    createdBy: string | null;
    deviationReason: string | null;
    deviationAmount: number | null;
  };
  epf: {
    externalParticipants: number | null;
    internalParticipants: number | null;
    eventBudget: number | null;
    annualBudget: number | null;
    availableBudget: number | null;
    dealerName: string | null;
    dealerPercent: number | null;
    dealerShare: number | null;
    tataHitachiPoAmount: number | null;
    status: string | null;
    lineItems: Array<{
      productName: string;
      quantity: number | null;
      amount: number | null;
    }>;
  } | null;
  crf: {
    lineItems: Array<{
      productName: string;
      quantity: number | null;
      amount: number | null;
    }>;
  } | null;
  workflow: {
    templateName: string | null;
    status: string;
    stages: Array<{
      stageName: string | null;
      stageOrder: number;
      status: string;
      approvals: Array<{
        approverName: string;
        status: string;
        isExternalApprover: boolean;
      }>;
    }>;
  } | null;
  comments: Array<{
    message: string;
    actorName: string;
    createdAt: Date;
    stageName: string | null;
  }>;
  activityLog: Array<{
    action: string;
    actorName: string;
    createdAt: Date;
    stageName: string | null;
  }>;
  generatedAt: Date;
}

// Prisma's Decimal fields aren't plain numbers — normalise once here so the
// docDefinition builder only ever deals with `number | null`.
const toNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const actorDisplayName = (
  staffActor: { first_name: string; last_name: string } | null | undefined,
  guestActor:
    | {
        name: string | null;
        email: string | null;
        mobile: string | null;
      }
    | null
    | undefined,
): string => {
  if (staffActor)
    return `${staffActor.first_name} ${staffActor.last_name}`.trim();
  if (guestActor)
    return guestActor.name ?? guestActor.email ?? guestActor.mobile ?? "Guest";
  return "System";
};

export async function assembleEpcPdfData(epcId: string): Promise<EpcPdfData> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    include: {
      department: { select: { department_name: true } },
      vertical: { select: { name: true } },
      region: { select: { region_name: true } },
      branch: { select: { branch_name: true } },
      event_name: { select: { title: true } },
      budget_master: { select: { value: true } },
      created_by: { select: { first_name: true, last_name: true } },
      epf: {
        include: {
          lineItems: {
            include: { product: { select: { name: true } } },
          },
        },
      },
      crf: {
        include: {
          lineItems: {
            include: { product: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (!epc) {
    throw new ApiError(404, "EPC record not found");
  }

  const activeWorkflow = await prisma.workflowInstance.findFirst({
    where: { subjectType: "EVENT_PROPOSAL", subjectId: epcId, isActive: true },
    orderBy: { created_at: "desc" },
    include: activeWorkflowInclude,
  });

  const workflowId = activeWorkflow?.id ?? null;

  const [approverComments, creatorComments, activityLogs] = workflowId
    ? await Promise.all([
        prisma.comment.findMany({
          where: {
            approvalId: { not: null },
            approval: { stage: { workflowId } },
          },
          select: {
            message: true,
            createdAt: true,
            user: { select: { first_name: true, last_name: true } },
            approval: {
              select: { stage: { select: { stageName: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.comment.findMany({
          where: { workflowId, approvalId: null },
          select: {
            message: true,
            createdAt: true,
            user: { select: { first_name: true, last_name: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.activityLog.findMany({
          where: {
            subjectType: "EVENT_PROPOSAL",
            subjectId: epcId,
            workflowId,
          },
          select: {
            action: true,
            createdAt: true,
            actor: { select: { first_name: true, last_name: true } },
            actorGuest: { select: { name: true, email: true, mobile: true } },
            stage: { select: { stageName: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
      ])
    : [[], [], []];

  const comments: EpcPdfData["comments"] = [
    ...approverComments.map((c) => ({
      message: c.message,
      actorName: actorDisplayName(c.user, null),
      createdAt: c.createdAt,
      stageName: c.approval?.stage.stageName ?? null,
    })),
    ...creatorComments.map((c) => ({
      message: c.message,
      actorName: actorDisplayName(c.user, null),
      createdAt: c.createdAt,
      stageName: null,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const activityLog: EpcPdfData["activityLog"] = activityLogs.map((a) => ({
    action: a.action,
    actorName: actorDisplayName(a.actor, a.actorGuest),
    createdAt: a.createdAt,
    stageName: a.stage?.stageName ?? null,
  }));

  return {
    epc: {
      proposalNumber: epc.proposal_number,
      eventName: epc.event_name?.title ?? null,
      eventFromDate: epc.event_from_date,
      eventToDate: epc.event_to_date,
      eventDescription: epc.event_description,
      location: epc.location,
      eventObjective: epc.event_objective,
      status: epc.status,
      department: epc.department?.department_name ?? null,
      vertical: epc.vertical?.name ?? null,
      region: epc.region?.region_name ?? null,
      branch: epc.branch?.branch_name ?? null,
      budgetMaster: toNumber(epc.budget_master?.value),
      createdBy: epc.created_by
        ? `${epc.created_by.first_name} ${epc.created_by.last_name}`.trim()
        : null,
      deviationReason: epc.deviationReason,
      deviationAmount: toNumber(epc.deviationAmount),
    },
    epf: epc.epf
      ? {
          externalParticipants: epc.epf.externalParticipants,
          internalParticipants: epc.epf.internalParticipants,
          eventBudget: toNumber(epc.epf.eventBudget),
          annualBudget: toNumber(epc.epf.annualBudget),
          availableBudget: toNumber(epc.epf.availableBudget),
          dealerName: epc.epf.dealerName,
          dealerPercent: epc.epf.dealerPercent,
          dealerShare: epc.epf.dealerShare,
          tataHitachiPoAmount: epc.epf.tataHitachiPoAmount,
          status: epc.epf.status,
          lineItems: epc.epf.lineItems.map((li) => ({
            productName: li.product.name,
            quantity: toNumber(li.quantity),
            amount: toNumber(li.amount),
          })),
        }
      : null,
    crf: epc.crf
      ? {
          lineItems: epc.crf.lineItems.map((li) => ({
            productName: li.product.name,
            quantity: toNumber(li.quantity),
            amount: toNumber(li.amount),
          })),
        }
      : null,
    workflow: activeWorkflow
      ? {
          templateName: activeWorkflow.template?.name ?? null,
          status: activeWorkflow.status,
          stages: activeWorkflow.stages.map((stage) => ({
            stageName: stage.stageName,
            stageOrder: stage.stageOrder,
            status: stage.status,
            approvals: stage.approvals.map((a) => ({
              approverName:
                `${a.approver.first_name} ${a.approver.last_name}`.trim(),
              status: a.status,
              isExternalApprover: a.isExternalApprover,
            })),
          })),
        }
      : null,
    comments,
    activityLog,
    generatedAt: new Date(),
  };
}

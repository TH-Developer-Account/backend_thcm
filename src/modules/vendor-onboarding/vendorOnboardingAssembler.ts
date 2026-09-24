import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  computePendingOn,
  resolveVendorOnboardingPendingOn,
  PendingOn,
} from "@workflow/workflowSubject.helper";

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR ONBOARDING — DATA ASSEMBLER
//
// Single responsibility: fetch the VendorOnboarding record + its documents
// (+ its active workflow + activity log, for the internal/employee copy) and
// shape them into the flat structure the docDefinition builders expect.
// Knows nothing about pdfmake, S3, or rendering.
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorOnboardingWorkflowApproval {
  approverName: string;
  status: string;
  actedAt: Date | null;
  reason: string | null;
  isExternalApprover: boolean;
}

export interface VendorOnboardingWorkflowStage {
  stageOrder: number;
  stageName: string | null;
  strategy: string;
  status: string;
  approvals: VendorOnboardingWorkflowApproval[];
}

export interface VendorOnboardingAuditTrailEntry {
  action: string;
  createdAt: Date;
  performedBy: string;
  reason: string | null;
}

export interface VendorOnboardingPdfData {
  vendor: {
    vendorName: string | null;
    state: string | null;
    city: string | null;
    pinCode: string | null;
    address: string | null;
    mobile: string | null;
    email: string | null;
    msmeVendor: boolean | null;
    gstin: string | null;
    pan: string | null;
    entityRegNo: string | null;
    vendorSubmittedAt: Date | null;
  };
  bank: {
    bankName: string | null;
    bankBranch: string | null;
    ifscCode: string | null;
    bankAddress: string | null;
    accountNumber: string | null;
  };
  procurement: {
    vendorCode: string | null;
    vendorType: string | null;
    companyCode: string | null;
    purchaseOrg: string | null;
    paymentTerm: string | null;
    tds: string | null;
    vendorCategory: string | null;
    materialType: string | null;
    materialSubType: string | null;
    natureOfService: string | null;
    onboardingReason: string | null;
    selfAssessmentObtained: boolean | null;
    ndaObtained: boolean | null;
    gpaObtained: boolean | null;
    isRelatedParty: boolean | null;
    vendorAuditReportPrepared: boolean | null;
  };
  documents: Array<{ documentType: string; uploadedAt: Date }>;
  // Workflow — current iteration only (mirrors getVendorOnboardingById's
  // activeWorkflow). null when no workflow has been assigned yet (still in
  // employee review, pre send-for-approval).
  workflow: { stages: VendorOnboardingWorkflowStage[] } | null;
  // Full chronological ActivityLog for this subject — initiation, vendor
  // submission, send-for-approval, clarify/approve/reject, closure.
  auditTrail: VendorOnboardingAuditTrailEntry[];
  // Same structured result the listing/detail endpoints already compute —
  // reused here rather than re-derived, so the PDF's dynamic status can
  // never drift from what the UI shows for the same record.
  pendingOn: PendingOn;
  status: string;
  generatedAt: Date;
}

export async function assembleVendorOnboardingPdfData(
  onboardingId: string,
): Promise<VendorOnboardingPdfData> {
  const onboarding = await prisma.vendorOnboarding.findUnique({
    where: { id: onboardingId },
    include: {
      documents: {
        select: { documentType: true, uploadedAt: true },
      },
    },
  });

  if (!onboarding) {
    throw new ApiError(404, "Vendor onboarding record not found");
  }

  // Current-iteration workflow, richer than activeWorkflowInclude
  // (@shared/utils/contants): the Workflow section on the PDF also needs
  // actedAt/reason per approval, which activeWorkflowInclude doesn't select
  // (it's tuned for pendingOn computation only). The shape below is still a
  // structural superset of what computePendingOn requires, so it's reused
  // for both the dynamic-status calculation and the printed table below —
  // one query, not two.
  const [activeWorkflow, activityLogs] = await Promise.all([
    prisma.workflowInstance.findFirst({
      where: {
        subjectType: "VENDOR_ONBOARDING",
        subjectId: onboardingId,
        isActive: true,
      },
      orderBy: { created_at: "desc" },
      select: {
        status: true,
        stages: {
          where: { isCurrentIteration: true },
          orderBy: { stageOrder: "asc" },
          select: {
            stageOrder: true,
            stageName: true,
            strategy: true,
            status: true,
            approvals: {
              select: {
                status: true,
                actedAt: true,
                reason: true,
                isExternalApprover: true,
                approver: {
                  select: { id: true, first_name: true, last_name: true },
                },
              },
            },
          },
        },
      },
    }),
    prisma.activityLog.findMany({
      where: { subjectType: "VENDOR_ONBOARDING", subjectId: onboardingId },
      orderBy: { createdAt: "asc" },
      select: {
        action: true,
        createdAt: true,
        metadata: true,
        actor: { select: { first_name: true, last_name: true } },
      },
    }),
  ]);

  const pendingOn = resolveVendorOnboardingPendingOn(
    onboarding.status,
    computePendingOn(activeWorkflow),
  );

  return {
    vendor: {
      vendorName: onboarding.vendorName,
      state: onboarding.state,
      city: onboarding.city,
      pinCode: onboarding.pinCode,
      address: onboarding.address,
      mobile: onboarding.mobile,
      email: onboarding.email,
      msmeVendor: onboarding.msmeVendor,
      gstin: onboarding.gstin,
      pan: onboarding.pan,
      entityRegNo: onboarding.entityRegNo,
      vendorSubmittedAt: onboarding.vendorSubmittedAt,
    },
    bank: {
      bankName: onboarding.bankName,
      bankBranch: onboarding.bankBranch,
      ifscCode: onboarding.ifscCode,
      bankAddress: onboarding.bankAddress,
      accountNumber: onboarding.accountNumber,
    },
    procurement: {
      vendorCode: onboarding.vendorCode,
      vendorType: onboarding.vendorType,
      companyCode: onboarding.companyCode,
      purchaseOrg: onboarding.purchaseOrg,
      paymentTerm: onboarding.paymentTerm,
      tds: onboarding.tds,
      vendorCategory: onboarding.vendorCategory,
      materialType: onboarding.materialType,
      materialSubType: onboarding.materialSubType,
      natureOfService: onboarding.natureOfService,
      onboardingReason: onboarding.onboardingReason,
      selfAssessmentObtained: onboarding.selfAssessmentObtained,
      ndaObtained: onboarding.ndaObtained,
      gpaObtained: onboarding.gpaObtained,
      isRelatedParty: onboarding.isRelatedParty,
      vendorAuditReportPrepared: onboarding.vendorAuditReportPrepared,
    },
    documents: onboarding.documents,
    workflow: activeWorkflow
      ? {
          stages: activeWorkflow.stages.map((stage) => ({
            stageOrder: stage.stageOrder,
            stageName: stage.stageName,
            strategy: stage.strategy,
            status: stage.status,
            approvals: stage.approvals.map((approval) => ({
              approverName: `${approval.approver.first_name} ${approval.approver.last_name}`,
              status: approval.status,
              actedAt: approval.actedAt,
              reason: approval.reason,
              isExternalApprover: approval.isExternalApprover,
            })),
          })),
        }
      : null,
    auditTrail: activityLogs.map((log) => ({
      action: log.action,
      createdAt: log.createdAt,
      performedBy: log.actor
        ? `${log.actor.first_name} ${log.actor.last_name}`
        : "System",
      reason: (log.metadata as { reason?: string } | null)?.reason ?? null,
    })),
    pendingOn,
    status: onboarding.status,
    generatedAt: new Date(),
  };
}

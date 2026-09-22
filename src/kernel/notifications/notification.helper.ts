import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { WorkflowSubjectType } from "../../prisma/generated/prisma/client";
// ─────────────────────────────────────────────────────────────────────────────
// getSubjectNotificationMeta  ✅ NEW
//
// Returns the standard fields every notify() call site needs, regardless of
// app: who to notify, what to call the subject, and where it links to. This
// is the single place that knows how to translate a subjectType + subjectId
// into notification-ready content — new apps add one entry here, and every
// approveStage/rejectStage-style caller gets support for free.
//
// EVENT_PROPOSAL    → EventProposal (proposal_number, created_by_id)
// VENDOR_ONBOARDING → VendorOnboarding (vendorName, initiatedById)
// AUDIT_INSTANCE    → AuditInstance (once the model exists for DIA)
// ─────────────────────────────────────────────────────────────────────────────
export interface SubjectNotificationMeta {
  ownerId: string | null;
  displayLabel: string;
  link: string;
}

const notificationMetaResolvers: Record<
  WorkflowSubjectType,
  (subjectId: string) => Promise<SubjectNotificationMeta | null>
> = {
  EVENT_PROPOSAL: async (subjectId) => {
    const epc = await prisma.eventProposal.findUnique({
      where: { id: subjectId },
      select: { proposal_number: true, created_by_id: true },
    });
    if (!epc) return null;

    return {
      ownerId: epc.created_by_id,
      displayLabel: epc.proposal_number
        ? `EPC ${epc.proposal_number}`
        : "Event proposal",
      link: `/map/epc/${subjectId}`,
    };
  },

  VENDOR_ONBOARDING: async (subjectId) => {
    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: subjectId },
      select: { vendorName: true, initiatedById: true },
    });
    if (!onboarding) return null;

    return {
      ownerId: onboarding.initiatedById,
      displayLabel: onboarding.vendorName
        ? `Vendor onboarding — ${onboarding.vendorName}`
        : "Vendor onboarding",
      link: `/vendor-onboarding/${subjectId}`,
    };
  },

  MEDICAL_CLAIM: async (subjectId) => {
    const claim = await prisma.medicalClaim.findUnique({
      where: { id: subjectId },
      select: {
        employeeName: true,
        referenceNumber: true,
        initiatedById: true,
      },
    });
    if (!claim) return null;

    return {
      ownerId: claim.initiatedById,
      displayLabel: claim.referenceNumber
        ? `Medical Claim ${claim.referenceNumber}`
        : claim.employeeName
          ? `Medical claim — ${claim.employeeName}`
          : "Medical claim",
      link: `/medical-claims/${subjectId}`,
    };
  },
  DEALER_AUDIT_INSTANCE: async (subjectId) => {
    const instance = await prisma.dealerAuditInstance.findUnique({
      where: { id: subjectId },
      select: {
        periodLabel: true,
        businessPartner: {
          select: {
            bpName: true,
            // Same "primary contact" resolution as workflowSubject.helper.ts's
            // getSubjectOwnerId — the instance belongs to the dealership, not
            // a single User, so its notification owner is the dealership's
            // designated primary contact.
            users: {
              where: { isDefaultContact: true, is_active: true },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!instance) return null;

    return {
      ownerId: instance.businessPartner.users[0]?.id ?? null,
      displayLabel: `Dealer Audit — ${instance.businessPartner.bpName} (${instance.periodLabel})`,
      link: `/dealer-audit/${subjectId}`,
    };
  },

  FACTORY_AUDIT_INSTANCE: async (subjectId) => {
    const instance = await prisma.factoryAuditInstance.findUnique({
      where: { id: subjectId },
      select: {
        createdByUserId: true,
        vendor: { select: { name: true } },
      },
    });
    if (!instance) return null;

    return {
      ownerId: instance.createdByUserId,
      displayLabel: `Factory Audit — ${instance.vendor.name}`,
      link: `/factory-audit/instances/${subjectId}`,
    };
  },
};

export async function getSubjectNotificationMeta(
  subjectType: WorkflowSubjectType,
  subjectId: string,
): Promise<SubjectNotificationMeta> {
  const resolver = notificationMetaResolvers[subjectType];
  if (!resolver) {
    throw new ApiError(400, `Unknown workflow subject type "${subjectType}"`);
  }

  const meta = await resolver(subjectId);
  if (!meta) {
    throw new ApiError(404, `${subjectType} not found for id "${subjectId}"`);
  }

  return meta;
}

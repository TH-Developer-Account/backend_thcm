import { Prisma } from "../prisma/generated/prisma/client";

export const SALT_ROUNDS = 10;
export const COOLDOWN_SECONDS = 60; // 1 OTP per 60s
export const MAX_ATTEMPTS = 5; // max 5 OTPs
export const WINDOW_SECONDS = 15 * 60; // in 15 minutes

export const profileInclude = {
  permissions: {
    include: {
      module: {
        select: {
          key: true,
          name: true,
          app: { select: { key: true, name: true } },
        },
      },
    },
    orderBy: [
      { module: { app: { key: "asc" as const } } },
      { module: { key: "asc" as const } },
      { action: "asc" as const },
    ],
  },
  userProfiles: {
    select: {
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
  _count: { select: { userProfiles: true } },
} satisfies Prisma.ProfileInclude;

export function formatProfile(profile: any) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    isSystemProfile: profile.isSystemProfile,
    assignedUserCount: profile._count.userProfiles,
    users: profile.userProfiles.map((up: any) => ({
      id: up.user.id,
      firstName: up.user.first_name,
      lastName: up.user.last_name,
      email: up.user.email,
    })),
    permissions: profile.permissions.map((p: any) => ({
      action: p.action,
      appKey: p.module.app.key,
      appName: p.module.app.name,
      moduleKey: p.module.key,
      moduleName: p.module.name,
    })),
  };
}

export const budgetMap: Record<string, { min: number; max: number | null }> = {
  below_20k: { min: 0, max: 20000 },
  "20k_3l": { min: 20000, max: 300000 },
  "3l_6l": { min: 300000, max: 600000 },
  "6l_10l": { min: 600000, max: 1000000 },
  above_10l: { min: 1000000, max: null },
};

export const epcFullInfoSelect = {
  department: {
    select: {
      id: true,
      department_name: true,
    },
  },
  vertical: {
    select: {
      id: true,
      name: true,
      code: true,
    },
  },
  region: {
    select: {
      id: true,
      region_name: true,
    },
  },
  branch: {
    select: {
      id: true,
      branch_name: true,
    },
  },
  event_name: {
    select: {
      id: true,
      title: true,
    },
  },
  budget_master: {
    select: {
      id: true,
      value: true,
    },
  },
  created_by: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone_number: true,
    },
  },
  epf: {
    select: {
      id: true,
      externalParticipants: true,
      internalParticipants: true,
      eventBudget: true,
      annualBudget: true,
      availableBudget: true,
      dealerName: true,
      dealerPercent: true,
      dealerShare: true,
      tataHitachiPoAmount: true,
      status: true,
      lineItems: {
        select: {
          id: true,
          quantity: true,
          amount: true,
          product: {
            select: {
              id: true,
              partNumber: true,
              name: true,
              description: true,
              category: true,
            },
          },
        },
      },
    },
  },
  crf: {
    select: {
      id: true,
      lineItems: {
        select: {
          id: true,
          quantity: true,
          amount: true,
          product: {
            select: {
              id: true,
              partNumber: true,
              name: true,
              description: true,
              category: true,
            },
          },
        },
      },
    },
  },
  report: {
    select: {
      id: true,
      epcId: true,
      status: true,
      remarks: true,
      outcomeStatus: true,
      totalLeadsGenerated: true,
      approvedEventCost: true,
      expectedConversion: true,
      validatorId: true,
      images: {
        select: {
          id: true,
          reportId: true,
          position: true,
          s3Key: true,
          fileUrl: true,
        },
      },
    },
  },
} as const;

export const activeWorkflowInclude = {
  template: {
    select: { id: true, name: true, description: true, metaData_1: true },
  },
  stages: {
    where: { isCurrentIteration: true },
    orderBy: { stageOrder: "asc" as const },
    include: {
      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              phone_number: true,
              isExternalApprover: true,
            },
          },
        },
      },
    },
  },
} as const;

export const REQUIRED_VENDOR_DOCUMENT_TYPES = [
  "GST_CERTIFICATE",
  "PAN_DOCUMENT",
  "CANCELLED_CHEQUE",
  "INCORPORATION_CERTIFICATE",
  "MSME_CERTIFICATE",
  "NDA_CERTIFICATE",
] as const;

export const OPTIONAL_VENDOR_DOCUMENT_TYPES = [
  "GENERAL_PURPOSE_AGREEMENT",
  "VENDOR_SELF_ASSESSMENT_FORM",
  // add more here as needed — no other code changes required
] as const;

export const ALL_VENDOR_DOCUMENT_TYPES = [
  ...REQUIRED_VENDOR_DOCUMENT_TYPES,
  ...OPTIONAL_VENDOR_DOCUMENT_TYPES,
] as const;

export type VendorDocumentType = (typeof ALL_VENDOR_DOCUMENT_TYPES)[number];

// MaterialType → valid MaterialSubType values. Enums can't express this
// relationship, so it's validated here rather than at the DB layer.
// Dummy values — fill in once real MaterialType/MaterialSubType enums are set.
export const MATERIAL_SUBTYPES_BY_TYPE: Record<string, string[]> = {
  RAW_MATERIAL: ["SUB_TYPE_1"],
  SERVICE: ["SUB_TYPE_2"],
};

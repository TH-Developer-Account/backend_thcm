import { prisma } from "@shared/config/prisma";
import { faker } from "@faker-js/faker";
import {
  MARKETING_ACTIVITY_PLANNER,
  VENDOR_ONBOARDING,
  EVENT_PLANNING_CALENDAR,
  branchData,
  eventNameData,
  regionData,
  budgetCodeData,
  verticalsData,
  products,
} from "./constants";
import { seedUsers, PROFILE_NAMES, ProfileName } from "./constants";
import { ProductMasterCreateManyInput } from "./generated/prisma/models";
import { generateVendorOnboardingReferenceNumber } from "../modules/vendor-onboarding/vendorOnboarding.helper";

async function main() {
  console.log("🌱 Seeding database...");

  // ─────────────────────────────────────────────
  // STEP 1: CLEAN ALL TABLES
  // ─────────────────────────────────────────────

  await prisma.approval.deleteMany();
  await prisma.stageInstance.deleteMany();
  await prisma.workflowInstance.deleteMany();
  await prisma.templateApprover.deleteMany();
  await prisma.templateStage.deleteMany();
  await prisma.workflowTemplate.deleteMany();

  await prisma.userProfile.deleteMany();
  await prisma.profilePermission.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.workspaceUser.deleteMany();
  await prisma.workspaceApp.deleteMany();
  await prisma.module.deleteMany();
  await prisma.app.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.lineItem.deleteMany();
  await prisma.productMaster.deleteMany();
  await prisma.cRF.deleteMany();
  await prisma.ePF.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.comment.deleteMany();

  // ✅ NEW — clean vendor onboarding tables too
  await prisma.vendorAccessToken.deleteMany();
  await prisma.vendorOnboardingDocument.deleteMany();
  await prisma.vendorOnboarding.deleteMany();

  await prisma.eventProposal.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.region.deleteMany();
  await prisma.vertical.deleteMany();
  await prisma.department.deleteMany();
  await prisma.budgetMaster.deleteMany();
  await prisma.eventName.deleteMany();
  await prisma.user.deleteMany();

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: WORKSPACE
  // ─────────────────────────────────────────────────────────────────────────

  const workspace = await prisma.workspace.create({
    data: { name: "Tata Hitachi Workspace" },
  });
  console.log("✅ Workspace created:", workspace.name);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: APPS — only MAP and Vendor Onboarding
  // ─────────────────────────────────────────────────────────────────────────

  const mapApp = await prisma.app.create({
    data: { key: "MAP", name: MARKETING_ACTIVITY_PLANNER },
  });

  const vendorApp = await prisma.app.create({
    data: { key: "VENDOR_ONBOARDING", name: VENDOR_ONBOARDING },
  });

  await prisma.workspaceApp.createMany({
    data: [
      { workspaceId: workspace.id, appId: mapApp.id },
      { workspaceId: workspace.id, appId: vendorApp.id },
    ],
  });
  console.log("✅ Apps enabled: MAP, Vendor Onboarding");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: MODULES
  // MAP has: EPC, EPF, CRF
  // Vendor Onboarding has: a single WORKFLOW_TEMPLATE module (per design)
  // ─────────────────────────────────────────────────────────────────────────

  const epcModule = await prisma.module.create({
    data: { key: "EPC", name: EVENT_PLANNING_CALENDAR, appId: mapApp.id },
  });
  const epfModule = await prisma.module.create({
    data: { key: "EPF", name: "Event Proposal Form", appId: mapApp.id },
  });
  const crfModule = await prisma.module.create({
    data: { key: "CRF", name: "Customer Response Form", appId: mapApp.id },
  });

  const vendorOnboardingModule = await prisma.module.create({
    data: {
      key: "VENDOR_INITIATION",
      name: "Vendor Initiation",
      appId: vendorApp.id,
    },
  });

  console.log("✅ Modules created for MAP and Vendor Onboarding");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: PROFILES
  //
  //  ┌─────────────────────────────┬───────────────────────────────────────┐
  //  │ Profile                     │ What it grants                        │
  //  ├─────────────────────────────┼───────────────────────────────────────┤
  //  │ Workspace Admin              │ read + write on everything            │
  //  │ MAP Admin                    │ read + write on MAP, read on Vendor   │
  //  │ Vendor Onboarding Admin      │ read + write on Vendor, read on MAP   │
  //  │ Field Engineer               │ read everywhere + write on all of MAP │
  //  │ EPC Specialist                │ read everywhere + write on MAP→EPC   │
  //  │ Vendor Onboarding Manager    │ read everywhere + write on Vendor     │
  //  │ Read-Only User                │ read on everything, no write at all  │
  //  └─────────────────────────────┴───────────────────────────────────────┘
  // ─────────────────────────────────────────────────────────────────────────

  // ── Profile: Workspace Admin ──────────────────────────────────────────────
  const adminProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.WORKSPACE_ADMIN,
      description: "Full access to all modules",
      workspaceId: workspace.id,
      isSystemProfile: true,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
          { action: "write", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: MAP Admin ─────────────────────────────────────────────────
  // WRITE + READ on all MAP modules. READ only on Vendor Onboarding.
  const mapAdminProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.MAP_ADMIN,
      description: "Full read+write on MAP, read on Vendor Onboarding",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: Vendor Onboarding Admin ──────────────────────────────────
  // WRITE + READ on Vendor Onboarding. READ only on MAP.
  const vendorOnboardingAdminProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.VENDOR_ONBOARDING_ADMIN,
      description: "Full read+write on Vendor Onboarding, read on MAP",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
          { action: "write", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: Field Engineer ────────────────────────────────────────────
  // WRITE + READ on all MAP modules. READ only on Vendor Onboarding.
  const fieldEngineerProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.FIELD_ENGINEER,
      description: "Read+write on MAP, read on Vendor Onboarding",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: EPC Specialist ────────────────────────────────────────────
  // WRITE + READ on MAP→EPC only. READ on everything else.
  const epcSpecialistProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.EPC_SPECIALIST,
      description: "Read+write on EPC module, read on everything else",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: Vendor Onboarding Manager ────────────────────────────────
  // WRITE + READ on Vendor Onboarding. READ only on MAP.
  const vendorOnboardingManagerProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.VENDOR_ONBOARDING_MANAGER,
      description: "Read+write on Vendor Onboarding, read on MAP",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
          { action: "write", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // ── Profile: Read-Only User ────────────────────────────────────────────
  const readOnlyProfile = await prisma.profile.create({
    data: {
      name: PROFILE_NAMES.READ_ONLY,
      description: "Read access to all modules, no write",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "read", moduleId: vendorOnboardingModule.id },
        ],
      },
    },
  });

  // Name → profile record lookup, used to drive Step 8's profile assignment
  // off `seedUsers[].profiles` instead of hardcoded index ranges.
  const profilesByName: Record<ProfileName, { id: string }> = {
    [PROFILE_NAMES.WORKSPACE_ADMIN]: adminProfile,
    [PROFILE_NAMES.MAP_ADMIN]: mapAdminProfile,
    [PROFILE_NAMES.VENDOR_ONBOARDING_ADMIN]: vendorOnboardingAdminProfile,
    [PROFILE_NAMES.FIELD_ENGINEER]: fieldEngineerProfile,
    [PROFILE_NAMES.EPC_SPECIALIST]: epcSpecialistProfile,
    [PROFILE_NAMES.VENDOR_ONBOARDING_MANAGER]: vendorOnboardingManagerProfile,
    [PROFILE_NAMES.READ_ONLY]: readOnlyProfile,
  };

  console.log(
    "✅ Profiles created: Workspace Admin, MAP Admin, Vendor Onboarding Admin, " +
      "Field Engineer, EPC Specialist, Vendor Onboarding Manager, Read-Only",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 6: USERS
  // Created from the static `seedUsers` definitions (see seedUsers.constants)
  // rather than faker-generated data, so identities and role assignments are
  // explicit and reproducible.
  // ─────────────────────────────────────────────────────────────────────────

  const users = await Promise.all(
    seedUsers.map((definition) =>
      prisma.user.create({
        data: {
          first_name: definition.first_name,
          last_name: definition.last_name,
          email: definition.email,
          phone_number: definition.phone_number,
          password: definition.password,
        },
      }),
    ),
  );
  console.log(`✅ ${users.length} users created`);

  // Name-keyed lookup so downstream references (workflow approvers, demo
  // checks, etc.) read as `usersByKey.vijay` instead of `users[1]`.
  const usersByKey: Record<string, (typeof users)[number]> = {};
  seedUsers.forEach((definition, index) => {
    usersByKey[definition.key] = users[index];
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: WORKSPACE MEMBERSHIP
  // isSuperAdmin comes from each user's definition (bypasses all permission
  // checks) rather than being inferred from array position.
  // ─────────────────────────────────────────────────────────────────────────

  await Promise.all(
    seedUsers.map((definition, index) =>
      prisma.workspaceUser.create({
        data: {
          userId: users[index].id,
          workspaceId: workspace.id,
          isSuperAdmin: definition.isSuperAdmin,
        },
      }),
    ),
  );

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 8: PROFILE ASSIGNMENTS
  // Driven entirely by `definition.profiles` — one user can hold multiple
  // profiles (e.g. the dual-role Field Engineer + Vendor Onboarding Manager).
  // ─────────────────────────────────────────────────────────────────────────

  await Promise.all(
    seedUsers.map((definition, index) =>
      prisma.userProfile.createMany({
        data: definition.profiles.map((profileName) => ({
          userId: users[index].id,
          workspaceId: workspace.id,
          profileId: profilesByName[profileName].id,
        })),
      }),
    ),
  );

  console.log("✅ Profile assignments complete");
  seedUsers.forEach((definition) => {
    console.log(
      `   ${definition.first_name} ${definition.last_name}: ${definition.profiles.join(", ")}${
        definition.isSuperAdmin ? " (Super Admin)" : ""
      }`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 9: MASTER DATA (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  const departments = await Promise.all(
    [
      "Marketing",
      "Service",
      "Corporate",
      "Parts",
      "Sales",
      "Manufacturing and Plant Administration",
    ].map((name) =>
      prisma.department.create({
        data: {
          department_code: name.slice(0, 3).toUpperCase(),
          department_name: name,
        },
      }),
    ),
  );

  for (const item of verticalsData) {
    const dept = departments.find(
      (d) => d.department_name === item.departmentName,
    );
    if (!dept) continue;

    await prisma.vertical.createMany({
      data: item.verticals.map((v) => ({
        name: v,
        code: v.slice(0, 3).toUpperCase(),
        departmentId: dept.id,
      })),
    });
  }

  await prisma.region.createMany({ data: regionData, skipDuplicates: true });
  const regions = await prisma.region.findMany();

  await prisma.branch.createMany({ data: branchData, skipDuplicates: true });
  const branches = await prisma.branch.findMany();

  await prisma.budgetMaster.createMany({
    data: budgetCodeData,
    skipDuplicates: true,
  });
  const budgets = await prisma.budgetMaster.findMany();

  await prisma.eventName.createMany({
    data: eventNameData,
    skipDuplicates: true,
  });
  const eventNames = await prisma.eventName.findMany();

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 10: EVENT PROPOSALS (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < 50; i++) {
    const department = faker.helpers.arrayElement(departments);
    const verticals = await prisma.vertical.findMany({
      where: { departmentId: department.id },
    });
    if (verticals.length === 0) {
      console.warn(
        `No verticals found for department ${department.department_name}`,
      );
      continue;
    }
    const vertical = faker.helpers.arrayElement(verticals);
    const region = faker.helpers.arrayElement(regions);
    const branch = faker.helpers.arrayElement(branches);
    const budget = faker.helpers.arrayElement(budgets);
    const eventName = faker.helpers.arrayElement(eventNames);
    const user = faker.helpers.arrayElement(users);

    const startDate = faker.date.future();
    const endDate = faker.date.soon({ days: 2, refDate: startDate });

    await prisma.eventProposal.create({
      data: {
        proposal_number: `EPF-${1000 + i}`,
        event_from_date: startDate,
        event_to_date: endDate,
        event_description: faker.lorem.sentences(2),
        location: faker.location.city(),
        event_objective: faker.company.catchPhrase(),
        status: faker.helpers.arrayElement([
          "RECOMMENDED",
          "PENDING",
          "SENT_BACK",
          "REPORT_SUBMITTED",
          "APPROVED",
          "SUBMITTED",
          "CANCELLED",
          "COMPLETED",
        ]),
        created_by_id: user.id,
        updated_by_id: user.id,
        department_id: department.id,
        vertical_id: vertical.id,
        region_id: region.id,
        branch_id: branch.id,
        event_scale: faker.helpers.arrayElement([
          10, 50, 100, 20000, 50000, 10000,
        ]),
        budget_master_id: budget.id,
        event_name_id: eventName.id,
      },
    });
  }

  console.log("✅ 50 event proposals created");

  // ─────────────────────────────────────────────────────────────────────────
  // PERMISSION CHECK DEMO — MAP + Vendor Onboarding only
  // ─────────────────────────────────────────────────────────────────────────
  console.log(
    "── Permission check demo ──────────────────────────────────────────",
  );

  async function can(
    userId: string,
    action: "read" | "write",
    moduleId: string,
  ): Promise<boolean> {
    const member = await prisma.workspaceUser.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
    });
    if (member?.isSuperAdmin) return true;

    const permission = await prisma.profilePermission.findFirst({
      where: {
        action,
        moduleId,
        profile: {
          userProfiles: { some: { userId, workspaceId: workspace.id } },
        },
      },
    });

    return permission !== null;
  }

  const fieldEngineerUser = usersByKey.vijay;
  const epcSpecialist = usersByKey.aswin;
  const vendorOnboardingManager = usersByKey.ashok;
  const readOnlyUser = usersByKey.nilanjan;

  const check = async (label: string, result: boolean, expected: boolean) => {
    const icon = result === expected ? "✅" : "❌";
    console.log(`${icon} ${label}: ${result} (expected ${expected})`);
  };

  await check(
    "FieldEng → WRITE EPC",
    await can(fieldEngineerUser.id, "write", epcModule.id),
    true,
  );
  await check(
    "FieldEng → READ  Vendor Onboarding",
    await can(fieldEngineerUser.id, "read", vendorOnboardingModule.id),
    true,
  );
  await check(
    "FieldEng → WRITE Vendor Onboarding",
    await can(fieldEngineerUser.id, "write", vendorOnboardingModule.id),
    false,
  );

  await check(
    "EPCSpec  → WRITE EPC",
    await can(epcSpecialist.id, "write", epcModule.id),
    true,
  );
  await check(
    "EPCSpec  → WRITE EPF",
    await can(epcSpecialist.id, "write", epfModule.id),
    false,
  );

  await check(
    "VendorMgr → WRITE Vendor Onboarding",
    await can(vendorOnboardingManager.id, "write", vendorOnboardingModule.id),
    true,
  );
  await check(
    "VendorMgr → WRITE EPC",
    await can(vendorOnboardingManager.id, "write", epcModule.id),
    false,
  );

  await check(
    "ReadOnly → READ  EPC",
    await can(readOnlyUser.id, "read", epcModule.id),
    true,
  );
  await check(
    "ReadOnly → WRITE EPC",
    await can(readOnlyUser.id, "write", epcModule.id),
    false,
  );

  console.log(
    "────────────────────────────────────────────────────────────────────\n",
  );

  // ─────────────────────────────────────────────
  // STEP 11: WORKFLOW TEMPLATE — MAP (unchanged)
  // ─────────────────────────────────────────────

  const template = await prisma.workflowTemplate.create({
    data: {
      name: "Standard EPC Approval",
      description: "This is the EPC Approval flow",
      workspaceId: workspace.id,
      created_by_id: usersByKey.syedFazal.id,
      updated_by_id: usersByKey.syedFazal.id,
      appId: mapApp.id,
      metaData_1: ">20000",
      metaData_2: "",
      metaData_3: "",
      stages: {
        create: [
          {
            name: "Checker",
            stageOrder: 1,
            strategy: "ANY",
            approvers: {
              create: [
                { userId: usersByKey.vijay.id },
                { userId: usersByKey.guruprasad.id },
              ],
            },
          },
          {
            name: "Recommender",
            stageOrder: 2,
            strategy: "ALL",
            approvers: {
              create: [
                { userId: usersByKey.aswin.id },
                { userId: usersByKey.ashok.id },
              ],
            },
          },
          {
            name: "Validator",
            stageOrder: 3,
            strategy: "SOME",
            minApprovals: 2,
            approvers: {
              create: [
                { userId: usersByKey.hemadri.id },
                { userId: usersByKey.nilanjan.id },
                { userId: usersByKey.amit.id },
              ],
            },
          },
        ],
      },
    },
  });

  console.log("✅ MAP workflow template created");

  // ─────────────────────────────────────────────
  // STEP 11b: WORKFLOW TEMPLATE — Vendor Onboarding ✅ NEW
  // Single template across workspace, per design decision.
  // ─────────────────────────────────────────────

  const vendorTemplate = await prisma.workflowTemplate.create({
    data: {
      name: "Standard Vendor Onboarding Approval",
      description: "Two-stage approval for vendor onboarding requests",
      workspaceId: workspace.id,
      created_by_id: usersByKey.syedFazal.id,
      updated_by_id: usersByKey.syedFazal.id,
      appId: vendorApp.id,
      metaData_1: "",
      metaData_2: "",
      metaData_3: "",
      stages: {
        create: [
          {
            name: "Approver",
            stageOrder: 1,
            strategy: "ANY",
            approvers: {
              create: [
                { userId: usersByKey.aswin.id },
                { userId: usersByKey.ashok.id },
              ],
            },
          },
          {
            name: "Final Reviewer",
            stageOrder: 2,
            strategy: "ANY",
            approvers: {
              create: [{ userId: usersByKey.hemadri.id }],
            },
          },
        ],
      },
    },
  });

  console.log("✅ Vendor Onboarding workflow template created");

  // ─────────────────────────────────────────────
  // STEP 12: WORKFLOW INSTANCES — MAP (unchanged)
  // ─────────────────────────────────────────────

  const proposals = await prisma.eventProposal.findMany({ take: 10 });

  const templateWithStages = await prisma.workflowTemplate.findUnique({
    where: { id: template.id },
    include: { stages: { include: { approvers: true } } },
  });

  if (!templateWithStages) throw new Error("Template not found");

  for (let i = 0; i < proposals.length; i++) {
    const epc = proposals[i];
    const activeStageOrder = (i % templateWithStages.stages.length) + 1;

    await prisma.workflowInstance.create({
      data: {
        subjectType: "EVENT_PROPOSAL",
        subjectId: epc.id,
        templateId: template.id,
        workspaceId: workspace.id,
        currentStage: activeStageOrder,
        appId: mapApp.id,
        stages: {
          create: templateWithStages.stages.map((stage) => {
            let status: "PENDING" | "IN_PROGRESS" | "APPROVED" = "PENDING";
            if (stage.stageOrder < activeStageOrder) status = "APPROVED";
            else if (stage.stageOrder === activeStageOrder)
              status = "IN_PROGRESS";

            return {
              stageOrder: stage.stageOrder,
              strategy: stage.strategy,
              minApprovals: stage.minApprovals,
              status,
              approvals: {
                create: stage.approvers.map((a) => ({
                  approverId: a.userId,
                  status:
                    stage.stageOrder < activeStageOrder
                      ? "APPROVED"
                      : "PENDING",
                  actedAt:
                    stage.stageOrder < activeStageOrder ? new Date() : null,
                })),
              },
            };
          }),
        },
      },
    });
  }

  // ─────────────────────────────────────────────
  // 1️⃣ Products, EPF/CRF (unchanged)
  // ─────────────────────────────────────────────

  await prisma.productMaster.createMany({
    data: products as ProductMasterCreateManyInput[],
    skipDuplicates: true,
  });

  console.log("✅ Products created");

  const allProducts = await prisma.productMaster.findMany();
  const epfProducts = allProducts.filter((p) => p.productType === "EPF");
  const crfProducts = allProducts.filter((p) => p.productType === "CRF");

  for (let i = 0; i < proposals.length; i++) {
    const epc = proposals[i];

    const epf = await prisma.ePF.create({
      data: {
        epcId: epc.id,
        externalParticipants: Math.floor(Math.random() * 50) + 10,
        internalParticipants: Math.floor(Math.random() * 30) + 5,
        eventBudget: Math.floor(Math.random() * (30000 - 20000 + 1)) + 20000,
        annualBudget:
          Math.floor(Math.random() * (500000 - 200000 + 1)) + 200000,
        availableBudget:
          Math.floor(Math.random() * (100000 - 50000 + 1)) + 50000,
        dealerName: "Sample Dealer",
        dealerPercent: Math.floor(Math.random() * 50) + 1,
        dealerShare: Math.floor(Math.random() * 20000) + 5000,
        tataHitachiPoAmount: Math.floor(Math.random() * 30000) + 10000,
        status: "ACTIVE",
      },
    });

    const crf = await prisma.cRF.create({ data: { epcId: epc.id } });

    for (const product of epfProducts) {
      const quantity = Math.floor(Math.random() * 3) + 1;
      const rate = product.unitRate;
      await prisma.lineItem.create({
        data: {
          epfId: epf.id,
          productId: product.id,
          quantity,
          rate,
          amount: quantity * Number(rate),
        },
      });
    }

    for (const product of crfProducts) {
      const quantity = Math.floor(Math.random() * 10) + 1;
      const rate = product.unitRate;
      await prisma.lineItem.create({
        data: {
          crfId: crf.id,
          productId: product.id,
          quantity,
          rate,
          amount: quantity * Number(rate),
        },
      });
    }
  }

  console.log("✅ EPF and CRF created");

  // ─────────────────────────────────────────────
  // STEP 13: SAMPLE VENDOR ONBOARDING RECORD ✅ NEW
  // One seeded record so the frontend has something to render immediately.
  // ─────────────────────────────────────────────

  await prisma.vendorOnboarding.create({
    data: {
      workspaceId: workspace.id,
      initiatedById: usersByKey.vijay.id, // a Field Engineer, matches "employee initiates" flow
      status: "AWAITING_VENDOR",
      referenceNumber: generateVendorOnboardingReferenceNumber(
        faker.company.name(),
      ),
      vendorName: faker.company.name(),
      mobile: `9${faker.string.numeric(9)}`,
      email: faker.internet.email().toLowerCase(),
    },
  });

  console.log("✅ Sample vendor onboarding record created");
  console.log("\n🎉 Seeding completed successfully\n");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

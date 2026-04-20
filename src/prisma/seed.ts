import { prisma } from "../config/prisma";
import { faker } from "@faker-js/faker";
import {
  MARKETING_ACTIVITY_PLANNER,
  EVENT_PLANNING_CALENDAR,
  branchData,
  eventNameData,
  regionData,
  budgetCodeData,
  verticalsData,
} from "./constants";

async function main() {
  console.log("🌱 Seeding database...");

  // ─────────────────────────────────────────────
  // STEP 1: CLEAN ALL TABLES
  // ─────────────────────────────────────────────

  // ✅ WORKFLOW CLEANUP (ADDED)
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
  // STEP 3: APPS
  // Think of these as the big products your company uses.
  // They are global (not tied to a workspace) — the WorkspaceApp table
  // is what "installs" them into a workspace.
  // ─────────────────────────────────────────────────────────────────────────

  const mapApp = await prisma.app.create({
    data: { key: "MAP", name: MARKETING_ACTIVITY_PLANNER },
  });

  const cmdApp = await prisma.app.create({
    data: { key: "CUSTOMER_MASTER_DATA", name: "Customer Master Data" },
  });

  const dcApp = await prisma.app.create({
    data: { key: "DEALER_CLAIMS", name: "Dealer Claims" },
  });

  // Enable all three apps for the workspace
  await prisma.workspaceApp.createMany({
    data: [
      { workspaceId: workspace.id, appId: mapApp.id },
      { workspaceId: workspace.id, appId: cmdApp.id },
      { workspaceId: workspace.id, appId: dcApp.id },
    ],
  });
  console.log("✅ Apps enabled: MAP, HR, CRM");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: MODULES
  // Each module is a feature area within an app.
  // MAP has: EPC, EPF, CRF
  // HR has:  Payroll, Employee Management
  // CRM has: Leads, Deals
  // ─────────────────────────────────────────────────────────────────────────

  // MAP modules
  const epcModule = await prisma.module.create({
    data: { key: "EPC", name: EVENT_PLANNING_CALENDAR, appId: mapApp.id },
  });
  const epfModule = await prisma.module.create({
    data: { key: "EPF", name: "Event Proposal Form", appId: mapApp.id },
  });
  const crfModule = await prisma.module.create({
    data: { key: "CRF", name: "Customer Response Form", appId: mapApp.id },
  });

  // HR modules
  const payrollModule = await prisma.module.create({
    data: { key: "PAYROLL", name: "Payroll Management", appId: cmdApp.id },
  });
  const employeeModule = await prisma.module.create({
    data: { key: "EMP_MGMT", name: "Employee Management", appId: cmdApp.id },
  });

  // CRM modules
  const leadsModule = await prisma.module.create({
    data: { key: "LEADS", name: "Leads", appId: dcApp.id },
  });
  const dealsModule = await prisma.module.create({
    data: { key: "DEALS", name: "Deals", appId: dcApp.id },
  });

  console.log("✅ Modules created for MAP, HR, CRM");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: PROFILES
  //
  // This is the core of the redesign. Each profile is a NAMED BUNDLE
  // of scoped permission rows. The scope (WORKSPACE / APP / MODULE)
  // lives on each permission row — NOT on the profile itself.
  //
  // Profile summary:
  //
  //  ┌─────────────────────┬──────────────────────────────────────────────┐
  //  │ Profile             │ What it grants                               │
  //  ├─────────────────────┼──────────────────────────────────────────────┤
  //  │ Workspace Admin     │ read + write on EVERYTHING                   │
  //  │ Field Engineer      │ read everywhere + write on all of MAP        │
  //  │ HR Admin            │ read everywhere + write on all of HR         │
  //  │ EPC Specialist      │ read everywhere + write on MAP→EPC only      │
  //  │ Read-Only User      │ read on everything, no write at all          │
  //  └─────────────────────┴──────────────────────────────────────────────┘
  // ─────────────────────────────────────────────────────────────────────────

  // ── Profile 1: Workspace Admin ────────────────────────────────────────────
  // READ + WRITE on every module across all apps.
  const adminProfile = await prisma.profile.create({
    data: {
      name: "Workspace Admin",
      description: "Full access to all modules",
      workspaceId: workspace.id,
      isSystemProfile: true,
      permissions: {
        create: [
          // MAP
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          // HR
          { action: "read", moduleId: payrollModule.id },
          { action: "write", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          { action: "write", moduleId: employeeModule.id },
          // CRM
          { action: "read", moduleId: leadsModule.id },
          { action: "write", moduleId: leadsModule.id },
          { action: "read", moduleId: dealsModule.id },
          { action: "write", moduleId: dealsModule.id },
        ],
      },
    },
  });

  // ── Profile 2: Field Engineer ─────────────────────────────────────────────
  // READ + WRITE on all MAP modules.
  // READ on HR and CRM modules.
  // No access to anything not listed here.
  const fieldEngineerProfile = await prisma.profile.create({
    data: {
      name: "Field Engineer",
      description: "Read+write on MAP, read on HR and CRM",
      workspaceId: workspace.id,
      permissions: {
        create: [
          // MAP — full access
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          // HR — read only
          { action: "read", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          // CRM — read only
          { action: "read", moduleId: leadsModule.id },
          { action: "read", moduleId: dealsModule.id },
        ],
      },
    },
  });

  // ── Profile 3: HR Admin ───────────────────────────────────────────────────
  // READ + WRITE on all HR modules.
  // READ on MAP and CRM modules.
  const hrAdminProfile = await prisma.profile.create({
    data: {
      name: "HR Admin",
      description: "Read+write on HR, read on MAP and CRM",
      workspaceId: workspace.id,
      permissions: {
        create: [
          // MAP — read only
          { action: "read", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          // HR — full access
          { action: "read", moduleId: payrollModule.id },
          { action: "write", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          { action: "write", moduleId: employeeModule.id },
          // CRM — read only
          { action: "read", moduleId: leadsModule.id },
          { action: "read", moduleId: dealsModule.id },
        ],
      },
    },
  });

  // ── Profile 4: EPC Specialist ─────────────────────────────────────────────
  // READ + WRITE on MAP→EPC only.
  // READ on everything else.
  const epcSpecialistProfile = await prisma.profile.create({
    data: {
      name: "EPC Specialist",
      description: "Read+write on EPC module, read on everything else",
      workspaceId: workspace.id,
      permissions: {
        create: [
          // MAP
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id }, // only EPC gets write
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          // HR
          { action: "read", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          // CRM
          { action: "read", moduleId: leadsModule.id },
          { action: "read", moduleId: dealsModule.id },
        ],
      },
    },
  });

  // ── Profile 5: Read-Only User ─────────────────────────────────────────────
  // READ on every module. No write anywhere.
  const readOnlyProfile = await prisma.profile.create({
    data: {
      name: "Read-Only User",
      description: "Read access to all modules, no write",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "read", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          { action: "read", moduleId: leadsModule.id },
          { action: "read", moduleId: dealsModule.id },
        ],
      },
    },
  });

  // ── Profile 6: CRM Restricted ─────────────────────────────────────────────
  // READ + WRITE on MAP. READ on HR. NO access to CRM at all.
  // This profile demonstrates the key point: CRM modules are simply
  // not listed, so hasPermission() returns false for any CRM path.
  const crmRestrictedProfile = await prisma.profile.create({
    data: {
      name: "CRM Restricted",
      description: "Full MAP access, HR read, no CRM access",
      workspaceId: workspace.id,
      permissions: {
        create: [
          // MAP — full access
          { action: "read", moduleId: epcModule.id },
          { action: "write", moduleId: epcModule.id },
          { action: "read", moduleId: epfModule.id },
          { action: "write", moduleId: epfModule.id },
          { action: "read", moduleId: crfModule.id },
          { action: "write", moduleId: crfModule.id },
          // HR — read only
          { action: "read", moduleId: payrollModule.id },
          { action: "read", moduleId: employeeModule.id },
          // CRM — intentionally omitted → no access at all
        ],
      },
    },
  });

  console.log(
    "✅ Profiles created: Admin, Field Engineer, HR Admin, EPC Specialist, Read-Only, CRM Restricted",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 6: USERS
  // ─────────────────────────────────────────────────────────────────────────

  const users = await Promise.all(
    Array.from({ length: 10 }).map(() =>
      prisma.user.create({
        data: {
          first_name: faker.person.firstName(),
          last_name: faker.person.lastName(),
          email: faker.internet.email().toLowerCase(),
          phone_number: `9${faker.string.numeric(9)}`,
          password: "Password@123",
        },
      }),
    ),
  );
  console.log(`✅ ${users.length} users created`);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: WORKSPACE MEMBERSHIP
  // User 0 is the superadmin (bypasses all permission checks).
  // ─────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < users.length; i++) {
    await prisma.workspaceUser.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        isSuperAdmin: i === 0, // only the first user is superadmin
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 8: PROFILE ASSIGNMENTS
  //
  // This shows the power of the new design:
  //
  //   User 0 (superadmin) → Workspace Admin profile
  //   Users 1–3           → Field Engineer  (WRITE on MAP, READ elsewhere)
  //   Users 4–5           → HR Admin        (WRITE on HR, READ elsewhere)
  //   User 6              → EPC Specialist  (WRITE on EPC only, READ elsewhere)
  //   User 7              → TWO profiles simultaneously:
  //                           Field Engineer + HR Admin
  //                           → WRITE on MAP + WRITE on HR + READ elsewhere
  //   Users 8–9           → Read-Only User
  // ─────────────────────────────────────────────────────────────────────────

  // User 0 — Workspace Admin
  await prisma.userProfile.create({
    data: {
      userId: users[0].id,
      workspaceId: workspace.id,
      profileId: adminProfile.id,
    },
  });

  // Users 1–3 — Field Engineer
  for (let i = 1; i <= 3; i++) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: fieldEngineerProfile.id,
      },
    });
  }

  // Users 4–5 — HR Admin
  for (let i = 4; i <= 5; i++) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: hrAdminProfile.id,
      },
    });
  }

  // User 6 — EPC Specialist
  await prisma.userProfile.create({
    data: {
      userId: users[6].id,
      workspaceId: workspace.id,
      profileId: epcSpecialistProfile.id,
    },
  });

  // User 7 — BOTH Field Engineer AND HR Admin (multiple profiles!)
  // This user gets WRITE on MAP + WRITE on HR + READ everywhere.
  // The permission check will pass if ANY profile grants the action.
  await prisma.userProfile.createMany({
    data: [
      {
        userId: users[7].id,
        workspaceId: workspace.id,
        profileId: fieldEngineerProfile.id,
      },
      {
        userId: users[7].id,
        workspaceId: workspace.id,
        profileId: hrAdminProfile.id,
      },
    ],
  });

  // Users 8–9 — Read-Only
  for (let i = 8; i <= 9; i++) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: readOnlyProfile.id,
      },
    });
  }

  console.log("✅ Profile assignments complete");
  console.log(
    "   User 0:   Workspace Admin  (superadmin bypass + admin profile)",
  );
  console.log("   Users 1–3: Field Engineer  (WRITE on MAP + READ everywhere)");
  console.log("   Users 4–5: HR Admin        (WRITE on HR  + READ everywhere)");
  console.log("   User 6:    EPC Specialist  (WRITE on EPC + READ everywhere)");
  console.log(
    "   User 7:    Field Engineer + HR Admin  (WRITE MAP+HR + READ everywhere)",
  );
  console.log("   Users 8–9: Read-Only       (READ everywhere, no WRITE)");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 9: MASTER DATA (unchanged from original)
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
  // STEP 10: EVENT PROPOSALS (unchanged from original)
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
      continue; // skip this iteration
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
        proposal_number: `EPF-${faker.number.int({ min: 1000, max: 9999 })}`,
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
  console.log("\n🎉 Seeding completed successfully\n");

  // ─────────────────────────────────────────────────────────────────────────
  // PERMISSION CHECK DEMO
  // Run this after seeding to verify the logic works correctly.
  // ─────────────────────────────────────────────────────────────────────────
  console.log(
    "── Permission check demo ──────────────────────────────────────────",
  );

  // Matches the new schema exactly — no scopeType, no appId on ProfilePermission.
  // Just action + moduleId. That's the whole check.
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

  const fieldEngineerUser = users[1];
  const hrAdminUser = users[4];
  const epcSpecialist = users[6];
  const readOnlyUser = users[8];
  const crmRestrictedUser = users[3]; // also a Field Engineer — has no CRM rows

  const check = async (label: string, result: boolean, expected: boolean) => {
    const icon = result === expected ? "✅" : "❌";
    console.log(`${icon} ${label}: ${result} (expected ${expected})`);
  };

  // Field Engineer: WRITE on MAP, READ on HR, no WRITE on HR
  await check(
    "FieldEng → WRITE EPC",
    await can(fieldEngineerUser.id, "write", epcModule.id),
    true,
  );
  await check(
    "FieldEng → WRITE EPF",
    await can(fieldEngineerUser.id, "write", epfModule.id),
    true,
  );
  await check(
    "FieldEng → READ  Payroll",
    await can(fieldEngineerUser.id, "read", payrollModule.id),
    true,
  );
  await check(
    "FieldEng → WRITE Payroll",
    await can(fieldEngineerUser.id, "write", payrollModule.id),
    false,
  );
  await check(
    "FieldEng → READ  Leads",
    await can(fieldEngineerUser.id, "read", leadsModule.id),
    true,
  );
  await check(
    "FieldEng → WRITE Leads",
    await can(fieldEngineerUser.id, "write", leadsModule.id),
    false,
  );

  // HR Admin: WRITE on HR, READ on MAP, no WRITE on MAP
  await check(
    "HRAdmin  → WRITE Payroll",
    await can(hrAdminUser.id, "write", payrollModule.id),
    true,
  );
  await check(
    "HRAdmin  → READ  EPC",
    await can(hrAdminUser.id, "read", epcModule.id),
    true,
  );
  await check(
    "HRAdmin  → WRITE EPC",
    await can(hrAdminUser.id, "write", epcModule.id),
    false,
  );

  // EPC Specialist: WRITE on EPC only
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
    "EPCSpec  → READ  Payroll",
    await can(epcSpecialist.id, "read", payrollModule.id),
    true,
  );

  // Read-Only: can read, cannot write
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

  // CRM Restricted (Field Engineer with no CRM rows): no access to CRM at all
  await check(
    "CRMRestricted → READ  Leads",
    await can(crmRestrictedUser.id, "read", leadsModule.id),
    false,
  );
  await check(
    "CRMRestricted → WRITE Leads",
    await can(crmRestrictedUser.id, "write", leadsModule.id),
    false,
  );

  console.log(
    "────────────────────────────────────────────────────────────────────\n",
  );

  // ─────────────────────────────────────────────
  // STEP 11: WORKFLOW TEMPLATE (ADDED)
  // ─────────────────────────────────────────────

  const template = await prisma.workflowTemplate.create({
    data: {
      name: "Standard EPC Approval",
      description: "This is the EPC Approval flow",
      workspaceId: workspace.id,
      created_by_id: users[0].id,
      updated_by_id: users[0].id,
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
              create: [{ userId: users[1].id }, { userId: users[2].id }],
            },
          },
          {
            name: "Recommender",
            stageOrder: 2,
            strategy: "ALL",
            approvers: {
              create: [{ userId: users[4].id }, { userId: users[5].id }],
            },
          },
          {
            name: "Validator",
            stageOrder: 3,
            strategy: "SOME",
            minApprovals: 2,
            approvers: {
              create: [
                { userId: users[6].id },
                { userId: users[7].id },
                { userId: users[8].id },
              ],
            },
          },
        ],
      },
    },
  });

  console.log("✅ Workflow template created");

  // ─────────────────────────────────────────────
  // STEP 12: WORKFLOW INSTANCES (ADDED)
  // ─────────────────────────────────────────────

  const proposals = await prisma.eventProposal.findMany({ take: 10 });

  const templateWithStages = await prisma.workflowTemplate.findUnique({
    where: { id: template.id },
    include: {
      stages: {
        include: {
          approvers: true,
        },
      },
    },
  });

  if (!templateWithStages) throw new Error("Template not found");

  for (let i = 0; i < proposals.length; i++) {
    const epc = proposals[i];

    // 👇 distribute stage (1,2,3,1,2,3...)
    const activeStageOrder = (i % templateWithStages.stages.length) + 1;

    await prisma.workflowInstance.create({
      data: {
        templateId: template.id,
        workspaceId: workspace.id,
        eventProposalId: epc.id,
        currentStage: activeStageOrder,

        stages: {
          create: templateWithStages.stages.map((stage) => {
            let status: "PENDING" | "IN_PROGRESS" | "APPROVED" = "PENDING";

            if (stage.stageOrder < activeStageOrder) {
              status = "APPROVED";
            } else if (stage.stageOrder === activeStageOrder) {
              status = "IN_PROGRESS";
            }

            return {
              stageOrder: stage.stageOrder,
              strategy: stage.strategy,
              minApprovals: stage.minApprovals,
              status,

              approvals: {
                create: stage.approvers.map((a) => ({
                  approverId: a.userId,

                  // 👇 mark approvals done for past stages
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

  // --------------------------------------------------
  // 1️⃣ Create Sample Products
  // --------------------------------------------------

  const products = await prisma.productMaster.createMany({
    data: [
      {
        partNumber: "EPF-001",
        name: "Venue Booking",
        description: "Hall and venue charges",
        unitRate: Math.floor(Math.random() * 50000),
        productType: "EPF",
        category: "EVENT_OVERHEAD",
      },
      {
        partNumber: "EPF-002",
        name: "Catering",
        description: "Food and beverages",
        unitRate: Math.floor(Math.random() * 1200),
        productType: "EPF",
        category: "EVENT_OVERHEAD",
      },

      // CRF Products
      {
        partNumber: "CRF-001",
        name: "Brochure Printing",
        description: "Product brochures",
        unitRate: Math.floor(Math.random() * 5000),
        productType: "CRF",
        category: "PRINTED_MATERIAL",
      },
      {
        partNumber: "CRF-002",
        name: "Gift Hampers",
        description: "Customer souvenirs",
        unitRate: Math.floor(Math.random() * 2500),
        productType: "CRF",
        category: "SOUVENIR",
      },
      {
        partNumber: "CRF-003",
        name: "Standee Design",
        description: "Artwork for banners",
        unitRate: Math.floor(Math.random() * 2000),
        productType: "CRF",
        category: "ARTWORK",
      },
    ],
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
        total_budget: Math.floor(Math.random() * (30000 - 20000 + 1)) + 20000,
        expected_revenue:
          Math.floor(Math.random() * (30000 - 20000 + 1)) + 20000,
      },
    });

    const crf = await prisma.cRF.create({
      data: {
        epcId: epc.id,
      },
    });

    for (const product of epfProducts) {
      const quantity = Math.floor(Math.random() * (3 - 1 + 1)) + 1;
      const rate = product.unitRate;
      const amount = quantity * Number(rate);

      await prisma.lineItem.create({
        data: {
          epfId: epf.id,
          productId: product.id,
          quantity,
          rate,
          amount,
        },
      });
    }

    for (const product of crfProducts) {
      const quantity = Math.floor(Math.random() * (10 - 1 + 1)) + 1;
      const rate = product.unitRate;
      const amount = quantity * Number(rate);

      await prisma.lineItem.create({
        data: {
          crfId: crf.id,
          productId: product.id,
          quantity,
          rate,
          amount,
        },
      });
    }
  }

  console.log("✅ EPF and CRF created");

  console.log("✅ Workflow instances created with distributed stages");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

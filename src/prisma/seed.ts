import { prisma } from "../config/prisma";
import { faker } from "@faker-js/faker";
import {
  MARKETING_ACTIVITY_PLANNER,
  EVENT_PLANNING_CALENDAR,
  branchData,
  eventNameData,
  regionData,
  budgetCodeData,
  eventScaleData,
} from "./constants";

async function main() {
  console.log("🌱 Seeding database...");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: CLEAN ALL TABLES
  // Order matters here — delete child tables before parent tables
  // to avoid foreign key constraint errors.
  // ─────────────────────────────────────────────────────────────────────────

  await prisma.userProfile.deleteMany(); // user ↔ profile assignments
  await prisma.profilePermission.deleteMany(); // permission rows inside profiles
  await prisma.profile.deleteMany(); // profile containers
  await prisma.workspaceUser.deleteMany(); // user ↔ workspace memberships
  await prisma.workspaceApp.deleteMany(); // workspace ↔ app links
  await prisma.module.deleteMany(); // modules (EPC, Payroll, etc.)
  await prisma.app.deleteMany(); // apps (MAP, HR, CRM)
  await prisma.workspace.deleteMany(); // workspace itself

  await prisma.eventProposal.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.region.deleteMany();
  await prisma.department.deleteMany();
  await prisma.eventScale.deleteMany();
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

  const hrApp = await prisma.app.create({
    data: { key: "HR", name: "Human Resources" },
  });

  const crmApp = await prisma.app.create({
    data: { key: "CRM", name: "Customer Relationship Management" },
  });

  // Enable all three apps for the workspace
  await prisma.workspaceApp.createMany({
    data: [
      { workspaceId: workspace.id, appId: mapApp.id },
      { workspaceId: workspace.id, appId: hrApp.id },
      { workspaceId: workspace.id, appId: crmApp.id },
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
    data: { key: "PAYROLL", name: "Payroll Management", appId: hrApp.id },
  });
  const employeeModule = await prisma.module.create({
    data: { key: "EMP_MGMT", name: "Employee Management", appId: hrApp.id },
  });

  // CRM modules
  const leadsModule = await prisma.module.create({
    data: { key: "LEADS", name: "Leads", appId: crmApp.id },
  });
  const dealsModule = await prisma.module.create({
    data: { key: "DEALS", name: "Deals", appId: crmApp.id },
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
  // Gets READ and WRITE at WORKSPACE scope = can do everything everywhere.
  const adminProfile = await prisma.profile.create({
    data: {
      name: "Workspace Admin",
      description: "Full read and write access across all apps and modules",
      workspaceId: workspace.id,
      isSystemProfile: true,
      permissions: {
        create: [
          { action: "read", scopeType: "WORKSPACE" },
          { action: "write", scopeType: "WORKSPACE" },
        ],
      },
    },
  });

  // ── Profile 2: Field Engineer ─────────────────────────────────────────────
  // This is the "READ everywhere + WRITE on all MAP modules" scenario
  // you asked about. One profile, one assignment, covers it entirely.
  //
  // How it works:
  //   Row 1: action=read,  scopeType=WORKSPACE → baseline READ on everything
  //   Row 2: action=write, scopeType=APP, appId=MAP → WRITE on ALL MAP modules
  //
  // When a new module is added to MAP tomorrow, this profile automatically
  // covers it — no data changes needed.
  const fieldEngineerProfile = await prisma.profile.create({
    data: {
      name: "Field Engineer",
      description: "Read access everywhere, write access to all MAP modules",
      workspaceId: workspace.id,
      permissions: {
        create: [
          {
            action: "read",
            scopeType: "WORKSPACE", // baseline: READ on everything
            appId: null,
            moduleId: null,
          },
          {
            action: "write",
            scopeType: "APP", // elevated: WRITE on all of MAP
            appId: mapApp.id,
            moduleId: null,
          },
        ],
      },
    },
  });

  // ── Profile 3: HR Admin ───────────────────────────────────────────────────
  // READ everywhere + WRITE on all HR modules.
  // Same pattern as Field Engineer but scoped to the HR app.
  const hrAdminProfile = await prisma.profile.create({
    data: {
      name: "HR Admin",
      description: "Read access everywhere, write access to all HR modules",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", scopeType: "WORKSPACE" },
          { action: "write", scopeType: "APP", appId: hrApp.id },
        ],
      },
    },
  });

  // ── Profile 4: EPC Specialist ─────────────────────────────────────────────
  // READ everywhere + WRITE on MAP→EPC module ONLY.
  // Uses MODULE scope to target one specific module, not the whole app.
  const epcSpecialistProfile = await prisma.profile.create({
    data: {
      name: "EPC Specialist",
      description: "Read access everywhere, write access to EPC module only",
      workspaceId: workspace.id,
      permissions: {
        create: [
          { action: "read", scopeType: "WORKSPACE" },
          {
            action: "write",
            scopeType: "MODULE", // narrowest scope: one module only
            appId: mapApp.id, // stored for fast querying
            moduleId: epcModule.id, // the specific module
          },
        ],
      },
    },
  });

  // ── Profile 5: Read-Only User ─────────────────────────────────────────────
  // Can see everything, cannot change anything.
  const readOnlyProfile = await prisma.profile.create({
    data: {
      name: "Read-Only User",
      description: "Read access across all apps, no write permissions",
      workspaceId: workspace.id,
      permissions: {
        create: [{ action: "read", scopeType: "WORKSPACE" }],
      },
    },
  });

  console.log(
    "✅ Profiles created: Admin, Field Engineer, HR Admin, EPC Specialist, Read-Only",
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
    ["Marketing", "HR", "Finance", "Operations", "Sales"].map((name) =>
      prisma.department.create({
        data: {
          department_code: name.slice(0, 3).toUpperCase(),
          department_name: name,
        },
      }),
    ),
  );

  await prisma.region.createMany({ data: regionData, skipDuplicates: true });
  const regions = await prisma.region.findMany();

  await prisma.branch.createMany({ data: branchData, skipDuplicates: true });
  const branches = await prisma.branch.findMany();

  await prisma.budgetMaster.createMany({
    data: budgetCodeData,
    skipDuplicates: true,
  });
  const budgets = await prisma.budgetMaster.findMany();

  await prisma.eventScale.createMany({
    data: eventScaleData,
    skipDuplicates: true,
  });
  const scales = await prisma.eventScale.findMany();

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
    const region = faker.helpers.arrayElement(regions);
    const branch = faker.helpers.arrayElement(branches);
    const scale = faker.helpers.arrayElement(scales);
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
        region_id: region.id,
        branch_id: branch.id,
        event_scale_id: scale.id,
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

  async function can(
    userId: string,
    action: "read" | "write",
    context: { appId?: string; moduleId?: string } = {},
  ): Promise<boolean> {
    const member = await prisma.workspaceUser.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
    });
    if (member?.isSuperAdmin) return true;

    const permissions = await prisma.profilePermission.findMany({
      where: {
        profile: {
          userProfiles: { some: { userId, workspaceId: workspace.id } },
        },
      },
    });

    return permissions.some((p) => {
      if (p.action !== action) return false;
      switch (p.scopeType) {
        case "WORKSPACE":
          return true;
        case "APP":
          return p.appId === context.appId;
        case "MODULE":
          return p.moduleId === context.moduleId;
        default:
          return false;
      }
    });
  }

  const fieldEngineerUser = users[1]; // Field Engineer
  const hrAdminUser = users[4]; // HR Admin
  const epcSpecialist = users[6]; // EPC Specialist
  const readOnlyUser = users[8]; // Read-Only

  const check = async (label: string, result: boolean, expected: boolean) => {
    const icon = result === expected ? "✅" : "❌";
    console.log(`${icon} ${label}: ${result} (expected ${expected})`);
  };

  // Field Engineer: should WRITE on MAP, READ on HR, no WRITE on HR
  await check(
    "FieldEng → WRITE EPC module",
    await can(fieldEngineerUser.id, "write", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    true,
  );
  await check(
    "FieldEng → WRITE EPF module",
    await can(fieldEngineerUser.id, "write", {
      appId: mapApp.id,
      moduleId: epfModule.id,
    }),
    true,
  );
  await check(
    "FieldEng → READ  HR Payroll",
    await can(fieldEngineerUser.id, "read", {
      appId: hrApp.id,
      moduleId: payrollModule.id,
    }),
    true,
  );
  await check(
    "FieldEng → WRITE HR Payroll",
    await can(fieldEngineerUser.id, "write", {
      appId: hrApp.id,
      moduleId: payrollModule.id,
    }),
    false,
  );

  // HR Admin: should WRITE on HR, READ on MAP, no WRITE on MAP
  await check(
    "HRAdmin  → WRITE Payroll",
    await can(hrAdminUser.id, "write", {
      appId: hrApp.id,
      moduleId: payrollModule.id,
    }),
    true,
  );
  await check(
    "HRAdmin  → READ  EPC module",
    await can(hrAdminUser.id, "read", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    true,
  );
  await check(
    "HRAdmin  → WRITE EPC module",
    await can(hrAdminUser.id, "write", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    false,
  );

  // EPC Specialist: WRITE on EPC only, not on EPF
  await check(
    "EPCSpec  → WRITE EPC module",
    await can(epcSpecialist.id, "write", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    true,
  );
  await check(
    "EPCSpec  → WRITE EPF module",
    await can(epcSpecialist.id, "write", {
      appId: mapApp.id,
      moduleId: epfModule.id,
    }),
    false,
  );

  // Read-Only: can read, cannot write anywhere
  await check(
    "ReadOnly → READ  EPC module",
    await can(readOnlyUser.id, "read", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    true,
  );
  await check(
    "ReadOnly → WRITE EPC module",
    await can(readOnlyUser.id, "write", {
      appId: mapApp.id,
      moduleId: epcModule.id,
    }),
    false,
  );

  console.log(
    "────────────────────────────────────────────────────────────────────\n",
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

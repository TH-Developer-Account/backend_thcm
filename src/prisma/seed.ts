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
  products,
} from "./constants";
import { ProductMasterCreateManyInput } from "./generated/prisma/models";

async function main() {
  console.log("🌱 Seeding database...");

  // ─────────────────────────────────────────────
  // STEP 1: CLEAN ALL TABLES
  // ─────────────────────────────────────────────

  // ✅ ORG HIERARCHY CLEANUP — FK-safe order (members → closure → units)
  await prisma.orgUnitMember.deleteMany();
  await prisma.orgUnitClosure.deleteMany();
  await prisma.orgUnit.deleteMany();

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
  await prisma.lineItem.deleteMany();
  await prisma.productMaster.deleteMany();
  await prisma.cRF.deleteMany();
  await prisma.ePF.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.comment.deleteMany();

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
  //
  // ✅ EXPANDED from 10 random users to 25 named users to support the
  // 3-department org hierarchy seeded in Step 13.
  //
  // Index → Name → Designation (org role)
  // ─────────────────────────────────────────────────────────────────────────

  const userDefs = [
    // Company-wide (indices 0–1)
    {
      first_name: "Rajesh",
      last_name: "Mehta",
      email: "rajesh.mehta@tatahitachi.com",
    },
    {
      first_name: "Sunita",
      last_name: "Krishnamurthy",
      email: "sunita.k@tatahitachi.com",
    },
    // Marketing (indices 2–8)
    {
      first_name: "Amit",
      last_name: "Sharma",
      email: "amit.sharma@tatahitachi.com",
    },
    {
      first_name: "Priya",
      last_name: "Nair",
      email: "priya.nair@tatahitachi.com",
    },
    {
      first_name: "Vikram",
      last_name: "Patel",
      email: "vikram.patel@tatahitachi.com",
    },
    {
      first_name: "Deepa",
      last_name: "Subramaniam",
      email: "deepa.s@tatahitachi.com",
    },
    {
      first_name: "Rohan",
      last_name: "Verma",
      email: "rohan.verma@tatahitachi.com",
    },
    {
      first_name: "Ananya",
      last_name: "Rao",
      email: "ananya.rao@tatahitachi.com",
    },
    {
      first_name: "Kiran",
      last_name: "Joshi",
      email: "kiran.joshi@tatahitachi.com",
    },
    // Sales (indices 9–14)
    {
      first_name: "Meera",
      last_name: "Iyer",
      email: "meera.iyer@tatahitachi.com",
    },
    {
      first_name: "Suresh",
      last_name: "Pillai",
      email: "suresh.pillai@tatahitachi.com",
    },
    {
      first_name: "Nandita",
      last_name: "Gupta",
      email: "nandita.gupta@tatahitachi.com",
    },
    {
      first_name: "Arun",
      last_name: "Krishnan",
      email: "arun.k@tatahitachi.com",
    },
    {
      first_name: "Lakshmi",
      last_name: "Venkat",
      email: "lakshmi.v@tatahitachi.com",
    },
    {
      first_name: "Sanjay",
      last_name: "Singh",
      email: "sanjay.singh@tatahitachi.com",
    },
    // Service (indices 15–24)
    {
      first_name: "Divya",
      last_name: "Rajan",
      email: "divya.rajan@tatahitachi.com",
    },
    {
      first_name: "Karthik",
      last_name: "Subramanian",
      email: "karthik.s@tatahitachi.com",
    },
    {
      first_name: "Pooja",
      last_name: "Tiwari",
      email: "pooja.tiwari@tatahitachi.com",
    },
    {
      first_name: "Rahul",
      last_name: "Bose",
      email: "rahul.bose@tatahitachi.com",
    },
    {
      first_name: "Sneha",
      last_name: "Kulkarni",
      email: "sneha.k@tatahitachi.com",
    },
    {
      first_name: "Naveen",
      last_name: "Reddy",
      email: "naveen.reddy@tatahitachi.com",
    },
    {
      first_name: "Harish",
      last_name: "Menon",
      email: "harish.menon@tatahitachi.com",
    },
    {
      first_name: "Tulsi",
      last_name: "Pandey",
      email: "tulsi.pandey@tatahitachi.com",
    },
    {
      first_name: "Girish",
      last_name: "Naik",
      email: "girish.naik@tatahitachi.com",
    },
    {
      first_name: "Mamta",
      last_name: "Dubey",
      email: "mamta.dubey@tatahitachi.com",
    },
  ];

  const users = await Promise.all(
    userDefs.map((def) =>
      prisma.user.create({
        data: {
          first_name: def.first_name,
          last_name: def.last_name,
          email: def.email,
          phone_number: `9${faker.string.numeric(9)}`,
          password: "Password@123",
        },
      }),
    ),
  );
  console.log(`✅ ${users.length} users created`);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: WORKSPACE MEMBERSHIP
  // User 0 (Rajesh Mehta — MD) is the superadmin.
  // ─────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < users.length; i++) {
    await prisma.workspaceUser.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        isSuperAdmin: i === 0, // only the MD is superadmin
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 8: PROFILE ASSIGNMENTS
  //
  //   [0]       Rajesh  (MD)            → Workspace Admin
  //   [1]       Sunita  (VP)            → Workspace Admin
  //   [2]       Amit    (Mkt Head)      → Field Engineer
  //   [3]       Priya   (Mkt Zonal S)   → Field Engineer
  //   [4]       Vikram  (Mkt Zonal N)   → Field Engineer
  //   [5]       Deepa   (Mkt Area Ch)   → Field Engineer
  //   [6]       Rohan   (Mkt Area De)   → Field Engineer
  //   [7]       Ananya  (Mkt Exec S)    → Field Engineer
  //   [8]       Kiran   (Mkt Exec N)    → Field Engineer
  //   [9]       Meera   (Sales Head)    → Field Engineer
  //   [10]      Suresh  (Sales Zonal S) → Field Engineer
  //   [11]      Nandita (Sales Zonal N) → Field Engineer
  //   [12–14]   Sales Reps              → Read-Only
  //   [15]      Divya   (Svc Head)      → HR Admin
  //   [16]      Karthik (Svc Zonal S)   → HR Admin
  //   [17]      Pooja   (Svc Zonal N)   → HR Admin
  //   [18–20]   Svc Area Heads          → HR Admin
  //   [21–24]   Svc Technicians         → Read-Only
  // ─────────────────────────────────────────────────────────────────────────

  // MD + VP → Workspace Admin
  for (const i of [0, 1]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: adminProfile.id,
      },
    });
  }

  // Marketing team → Field Engineer
  for (const i of [2, 3, 4, 5, 6, 7, 8]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: fieldEngineerProfile.id,
      },
    });
  }

  // Sales managers → Field Engineer
  for (const i of [9, 10, 11]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: fieldEngineerProfile.id,
      },
    });
  }

  // Sales reps → Read-Only
  for (const i of [12, 13, 14]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: readOnlyProfile.id,
      },
    });
  }

  // Service managers + area heads → HR Admin
  for (const i of [15, 16, 17, 18, 19, 20]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: hrAdminProfile.id,
      },
    });
  }

  // Service technicians → Read-Only
  for (const i of [21, 22, 23, 24]) {
    await prisma.userProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        profileId: readOnlyProfile.id,
      },
    });
  }

  console.log("✅ Profile assignments complete");
  console.log("   [0–1]   MD + VP           → Workspace Admin");
  console.log("   [2–11]  Marketing + Sales managers → Field Engineer");
  console.log("   [12–14] Sales Reps        → Read-Only");
  console.log("   [15–20] Service team      → HR Admin");
  console.log("   [21–24] Service techs     → Read-Only");

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

  // Resolve the three departments used by the org tree
  const mktDept = departments.find((d) => d.department_name === "Marketing")!;
  const salesDept = departments.find((d) => d.department_name === "Sales")!;
  const svcDept = departments.find((d) => d.department_name === "Service")!;

  // Use first two regions for South / North zones
  const southRegion = regions[0];
  const northRegion = regions[1];

  console.log("✅ Master data seeded");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 10: EVENT PROPOSALS
  //
  // ✅ CHANGED: each user gets exactly 5 EPCs with department_id and
  // region_id matching their org position so hierarchy scoping is
  // immediately verifiable during a demo.
  //
  // User-to-dept/region mapping:
  //   [0–1]   MD/VP  → Marketing dept, South region (placeholder)
  //   [2–8]   Mkt    → Marketing dept, South[3,5,7] or North[4,6,8]
  //   [9–14]  Sales  → Sales dept,     South[10,12,13] or North[11,14]
  //   [15–24] Service→ Service dept,   South[16,18,19,21,22] or North[17,20,23,24]
  // ─────────────────────────────────────────────────────────────────────────

  type UserMeta = {
    user: (typeof users)[0];
    deptId: string;
    regionId: string;
  };

  const userMeta: UserMeta[] = [
    // Company-wide
    { user: users[0], deptId: mktDept.id, regionId: southRegion.id },
    { user: users[1], deptId: mktDept.id, regionId: southRegion.id },
    // Marketing
    { user: users[2], deptId: mktDept.id, regionId: southRegion.id },
    { user: users[3], deptId: mktDept.id, regionId: southRegion.id },
    { user: users[4], deptId: mktDept.id, regionId: northRegion.id },
    { user: users[5], deptId: mktDept.id, regionId: southRegion.id },
    { user: users[6], deptId: mktDept.id, regionId: northRegion.id },
    { user: users[7], deptId: mktDept.id, regionId: southRegion.id },
    { user: users[8], deptId: mktDept.id, regionId: northRegion.id },
    // Sales
    { user: users[9], deptId: salesDept.id, regionId: southRegion.id },
    { user: users[10], deptId: salesDept.id, regionId: southRegion.id },
    { user: users[11], deptId: salesDept.id, regionId: northRegion.id },
    { user: users[12], deptId: salesDept.id, regionId: southRegion.id },
    { user: users[13], deptId: salesDept.id, regionId: southRegion.id },
    { user: users[14], deptId: salesDept.id, regionId: northRegion.id },
    // Service
    { user: users[15], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[16], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[17], deptId: svcDept.id, regionId: northRegion.id },
    { user: users[18], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[19], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[20], deptId: svcDept.id, regionId: northRegion.id },
    { user: users[21], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[22], deptId: svcDept.id, regionId: southRegion.id },
    { user: users[23], deptId: svcDept.id, regionId: northRegion.id },
    { user: users[24], deptId: svcDept.id, regionId: northRegion.id },
  ];

  const allProposals: { id: string }[] = [];

  for (const { user, deptId, regionId } of userMeta) {
    const dept = departments.find((d) => d.id === deptId)!;
    const verticals = await prisma.vertical.findMany({
      where: { departmentId: dept.id },
    });
    if (verticals.length === 0) continue;

    for (let j = 0; j < 5; j++) {
      const vertical = faker.helpers.arrayElement(verticals);
      const branch = faker.helpers.arrayElement(branches);
      const budget = faker.helpers.arrayElement(budgets);
      const eventName = faker.helpers.arrayElement(eventNames);
      const startDate = faker.date.future();
      const endDate = faker.date.soon({ days: 2, refDate: startDate });

      const proposal = await prisma.eventProposal.create({
        data: {
          proposal_number: `EPC-${user.first_name.slice(0, 3).toUpperCase()}-${faker.number.int({ min: 1000, max: 9999 })}`,
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
          department_id: deptId,
          vertical_id: vertical.id,
          region_id: regionId,
          branch_id: branch.id,
          event_scale: faker.helpers.arrayElement([
            10, 50, 100, 20000, 50000, 10000,
          ]),
          budget_master_id: budget.id,
          event_name_id: eventName.id,
        },
      });

      allProposals.push({ id: proposal.id });
    }
  }

  console.log(`✅ ${allProposals.length} event proposals created (5 per user)`);
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

  const fieldEngineerUser = users[3]; // Priya — Mkt Zonal Head
  const hrAdminUser = users[16]; // Karthik — Svc Zonal Head
  const epcSpecialist = users[5]; // Deepa — Mkt Area Head
  const readOnlyUser = users[12]; // Arun — Sales Rep
  const crmRestrictedUser = users[7]; // Ananya — Mkt Executive

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

  // ─────────────────────────────────────────
  // STEP 11: WORKFLOW TEMPLATE (ADDED)
  // ─────────────────────────────────────────

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
              create: [{ userId: users[3].id }, { userId: users[10].id }],
            },
          },
          {
            name: "Recommender",
            stageOrder: 2,
            strategy: "ALL",
            approvers: {
              create: [{ userId: users[2].id }, { userId: users[9].id }],
            },
          },
          {
            name: "Validator",
            stageOrder: 3,
            strategy: "SOME",
            minApprovals: 2,
            approvers: {
              create: [
                { userId: users[0].id },
                { userId: users[1].id },
                { userId: users[15].id },
              ],
            },
          },
        ],
      },
    },
  });

  console.log("✅ Workflow template created");

  // ─────────────────────────────────────────
  // STEP 12: WORKFLOW INSTANCES (ADDED)
  // ─────────────────────────────────────────

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

    // distribute stage (1,2,3,1,2,3...)
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
  // Create Sample Products
  // --------------------------------------------------

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

    const crf = await prisma.cRF.create({
      data: { epcId: epc.id },
    });

    for (const product of epfProducts) {
      const quantity = Math.floor(Math.random() * (3 - 1 + 1)) + 1;
      const rate = product.unitRate;
      const amount = quantity * Number(rate);
      await prisma.lineItem.create({
        data: { epfId: epf.id, productId: product.id, quantity, rate, amount },
      });
    }

    for (const product of crfProducts) {
      const quantity = Math.floor(Math.random() * (10 - 1 + 1)) + 1;
      const rate = product.unitRate;
      const amount = quantity * Number(rate);
      await prisma.lineItem.create({
        data: { crfId: crf.id, productId: product.id, quantity, rate, amount },
      });
    }
  }

  console.log("✅ EPF and CRF created");
  console.log("✅ Workflow instances created with distributed stages");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 13: ORG HIERARCHY
  //
  // 3-department tree with designation-based scoping.
  //
  // Company-wide (HEAD — no dept/zone filter)
  //   [0] Rajesh  MD         → sees ALL 125 EPCs
  //   [1] Sunita  VP         → sees ALL 125 EPCs
  //
  // Marketing (DEPT_HEAD → dept filter; ZONAL/AREA → dept + zone filter)
  //   [2] Amit    Mkt Head         DEPT_HEAD  dept=Mkt  zone=null
  //   [3] Priya   Mkt Zonal South  ZONAL_HEAD dept=Mkt  zone=South
  //   [4] Vikram  Mkt Zonal North  ZONAL_HEAD dept=Mkt  zone=North
  //   [5] Deepa   Mkt Area Chennai AREA_HEAD  dept=Mkt  zone=South
  //   [6] Rohan   Mkt Area Delhi   AREA_HEAD  dept=Mkt  zone=North
  //   [7] Ananya  Mkt Exec South   MEMBER
  //   [8] Kiran   Mkt Exec North   MEMBER
  //
  // Sales (flatter — no Area Head tier)
  //   [9]  Meera   Sales Head       DEPT_HEAD  dept=Sales zone=null
  //   [10] Suresh  Sales Zonal S    ZONAL_HEAD dept=Sales zone=South
  //   [11] Nandita Sales Zonal N    ZONAL_HEAD dept=Sales zone=North
  //   [12] Arun    Sales Rep S1     MEMBER
  //   [13] Lakshmi Sales Rep S2     MEMBER
  //   [14] Sanjay  Sales Rep N      MEMBER
  //
  // Service (two area heads per zone)
  //   [15] Divya   Svc Head         DEPT_HEAD  dept=Svc  zone=null
  //   [16] Karthik Svc Zonal S      ZONAL_HEAD dept=Svc  zone=South
  //   [17] Pooja   Svc Zonal N      ZONAL_HEAD dept=Svc  zone=North
  //   [18] Rahul   Svc Area Chennai AREA_HEAD  dept=Svc  zone=South
  //   [19] Sneha   Svc Area Blore   AREA_HEAD  dept=Svc  zone=South
  //   [20] Naveen  Svc Area Delhi   AREA_HEAD  dept=Svc  zone=North
  //   [21] Harish  Svc Tech S1      MEMBER
  //   [22] Tulsi   Svc Tech S2      MEMBER
  //   [23] Girish  Svc Tech N1      MEMBER
  //   [24] Mamta   Svc Tech N2      MEMBER
  // ─────────────────────────────────────────────────────────────────────────

  console.log(
    "\n── STEP 13: Org hierarchy ──────────────────────────────────────",
  );

  // ── Inline closure helper ────────────────────────────────────────────────
  async function insertClosureRows(
    unitId: string,
    parentId: string | null,
  ): Promise<void> {
    const rows: { ancestorId: string; descendantId: string; depth: number }[] =
      [{ ancestorId: unitId, descendantId: unitId, depth: 0 }];

    if (parentId !== null) {
      const parentAncestors = await prisma.orgUnitClosure.findMany({
        where: { descendantId: parentId },
        select: { ancestorId: true, depth: true },
      });
      for (const { ancestorId, depth } of parentAncestors) {
        rows.push({ ancestorId, descendantId: unitId, depth: depth + 1 });
      }
    }

    await prisma.orgUnitClosure.createMany({ data: rows });
  }

  // ── Helper to create a unit + wire closure in one call ───────────────────
  async function createUnit(data: {
    name: string;
    description: string;
    parentId: string | null;
    departmentId: string | null;
    regionId: string | null;
  }) {
    const unit = await prisma.orgUnit.create({
      data: { workspaceId: workspace.id, ...data },
    });
    await insertClosureRows(unit.id, data.parentId);
    return unit;
  }

  // ── Company-wide tier ────────────────────────────────────────────────────
  const mdUnit = await createUnit({
    name: "Tata Hitachi India",
    description: "MD level — company-wide visibility",
    parentId: null,
    departmentId: null,
    regionId: null,
  });

  const vpUnit = await createUnit({
    name: "VP Operations",
    description: "VP level — company-wide visibility",
    parentId: mdUnit.id,
    departmentId: null,
    regionId: null,
  });

  // ── Marketing tree ───────────────────────────────────────────────────────
  const mktNational = await createUnit({
    name: "Marketing — National",
    description: "Marketing Dept Head — all zones",
    parentId: vpUnit.id,
    departmentId: mktDept.id,
    regionId: null,
  });
  const mktSouth = await createUnit({
    name: "Marketing — South Zone",
    description: "Marketing Zonal Head South",
    parentId: mktNational.id,
    departmentId: mktDept.id,
    regionId: southRegion.id,
  });
  const mktNorth = await createUnit({
    name: "Marketing — North Zone",
    description: "Marketing Zonal Head North",
    parentId: mktNational.id,
    departmentId: mktDept.id,
    regionId: northRegion.id,
  });
  const mktChennai = await createUnit({
    name: "Marketing — Chennai Area",
    description: "Marketing Area Head Chennai",
    parentId: mktSouth.id,
    departmentId: mktDept.id,
    regionId: southRegion.id,
  });
  const mktDelhi = await createUnit({
    name: "Marketing — Delhi Area",
    description: "Marketing Area Head Delhi",
    parentId: mktNorth.id,
    departmentId: mktDept.id,
    regionId: northRegion.id,
  });

  // ── Sales tree (flat — no area head tier) ────────────────────────────────
  const salesNational = await createUnit({
    name: "Sales — National",
    description: "Sales Dept Head — all zones",
    parentId: vpUnit.id,
    departmentId: salesDept.id,
    regionId: null,
  });
  const salesSouth = await createUnit({
    name: "Sales — South Zone",
    description: "Sales Zonal Head South",
    parentId: salesNational.id,
    departmentId: salesDept.id,
    regionId: southRegion.id,
  });
  const salesNorth = await createUnit({
    name: "Sales — North Zone",
    description: "Sales Zonal Head North",
    parentId: salesNational.id,
    departmentId: salesDept.id,
    regionId: northRegion.id,
  });

  // ── Service tree (two area heads per zone) ───────────────────────────────
  const svcNational = await createUnit({
    name: "Service — National",
    description: "Service Dept Head — all zones",
    parentId: vpUnit.id,
    departmentId: svcDept.id,
    regionId: null,
  });
  const svcSouth = await createUnit({
    name: "Service — South Zone",
    description: "Service Zonal Head South",
    parentId: svcNational.id,
    departmentId: svcDept.id,
    regionId: southRegion.id,
  });
  const svcNorth = await createUnit({
    name: "Service — North Zone",
    description: "Service Zonal Head North",
    parentId: svcNational.id,
    departmentId: svcDept.id,
    regionId: northRegion.id,
  });
  const svcChennai = await createUnit({
    name: "Service — Chennai Area",
    description: "Service Area Head Chennai",
    parentId: svcSouth.id,
    departmentId: svcDept.id,
    regionId: southRegion.id,
  });
  const svcBangalore = await createUnit({
    name: "Service — Bangalore Area",
    description: "Service Area Head Bangalore",
    parentId: svcSouth.id,
    departmentId: svcDept.id,
    regionId: southRegion.id,
  });
  const svcDelhi = await createUnit({
    name: "Service — Delhi Area",
    description: "Service Area Head Delhi",
    parentId: svcNorth.id,
    departmentId: svcDept.id,
    regionId: northRegion.id,
  });

  console.log("✅ 15 org units created across 3 departments");

  // ── Members with designation levels ──────────────────────────────────────
  await prisma.orgUnitMember.createMany({
    data: [
      // Company-wide
      {
        orgUnitId: mdUnit.id,
        userId: users[0].id,
        role: "MANAGER",
        designationLevel: "HEAD",
      },
      {
        orgUnitId: vpUnit.id,
        userId: users[1].id,
        role: "MANAGER",
        designationLevel: "HEAD",
      },
      // Marketing
      {
        orgUnitId: mktNational.id,
        userId: users[2].id,
        role: "MANAGER",
        designationLevel: "DEPT_HEAD",
      },
      {
        orgUnitId: mktSouth.id,
        userId: users[3].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: mktNorth.id,
        userId: users[4].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: mktChennai.id,
        userId: users[5].id,
        role: "MANAGER",
        designationLevel: "AREA_HEAD",
      },
      {
        orgUnitId: mktDelhi.id,
        userId: users[6].id,
        role: "MANAGER",
        designationLevel: "AREA_HEAD",
      },
      {
        orgUnitId: mktChennai.id,
        userId: users[7].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: mktDelhi.id,
        userId: users[8].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      // Sales
      {
        orgUnitId: salesNational.id,
        userId: users[9].id,
        role: "MANAGER",
        designationLevel: "DEPT_HEAD",
      },
      {
        orgUnitId: salesSouth.id,
        userId: users[10].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: salesNorth.id,
        userId: users[11].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: salesSouth.id,
        userId: users[12].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: salesSouth.id,
        userId: users[13].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: salesNorth.id,
        userId: users[14].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      // Service
      {
        orgUnitId: svcNational.id,
        userId: users[15].id,
        role: "MANAGER",
        designationLevel: "DEPT_HEAD",
      },
      {
        orgUnitId: svcSouth.id,
        userId: users[16].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: svcNorth.id,
        userId: users[17].id,
        role: "MANAGER",
        designationLevel: "ZONAL_HEAD",
      },
      {
        orgUnitId: svcChennai.id,
        userId: users[18].id,
        role: "MANAGER",
        designationLevel: "AREA_HEAD",
      },
      {
        orgUnitId: svcBangalore.id,
        userId: users[19].id,
        role: "MANAGER",
        designationLevel: "AREA_HEAD",
      },
      {
        orgUnitId: svcDelhi.id,
        userId: users[20].id,
        role: "MANAGER",
        designationLevel: "AREA_HEAD",
      },
      {
        orgUnitId: svcChennai.id,
        userId: users[21].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: svcBangalore.id,
        userId: users[22].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: svcNorth.id,
        userId: users[23].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
      {
        orgUnitId: svcDelhi.id,
        userId: users[24].id,
        role: "MEMBER",
        designationLevel: "MEMBER",
      },
    ],
  });

  console.log("✅ 25 members assigned with designation levels");

  // ── Visibility verification ───────────────────────────────────────────────

  async function getSubtreeUserIds(userId: string): Promise<string[]> {
    const managedUnits = await prisma.orgUnitMember.findMany({
      where: { userId, role: "MANAGER" },
      select: { orgUnitId: true },
    });
    if (managedUnits.length === 0) return [userId];

    const managedUnitIds = managedUnits.map((m) => m.orgUnitId);
    const closureRows = await prisma.orgUnitClosure.findMany({
      where: { ancestorId: { in: managedUnitIds } },
      select: { descendantId: true },
    });
    const descendantUnitIds = [
      ...new Set(closureRows.map((r) => r.descendantId)),
    ];
    const members = await prisma.orgUnitMember.findMany({
      where: { orgUnitId: { in: descendantUnitIds } },
      select: { userId: true },
    });
    const ids = new Set(members.map((m) => m.userId));
    ids.add(userId);
    return [...ids];
  }

  async function getEpcScopingFilter(
    userId: string,
  ): Promise<Record<string, unknown>> {
    const memberships = await prisma.orgUnitMember.findMany({
      where: { userId, role: "MANAGER" },
      select: {
        designationLevel: true,
        orgUnit: { select: { departmentId: true, regionId: true } },
      },
    });
    if (memberships.length === 0) return {};
    if (memberships.some((m) => m.designationLevel === "HEAD")) return {};

    const deptHead = memberships.find(
      (m) => m.designationLevel === "DEPT_HEAD",
    );
    if (deptHead?.orgUnit.departmentId) {
      return { department_id: deptHead.orgUnit.departmentId };
    }
    const zonal = memberships.find((m) => m.designationLevel === "ZONAL_HEAD");
    if (zonal?.orgUnit.departmentId && zonal?.orgUnit.regionId) {
      return {
        department_id: zonal.orgUnit.departmentId,
        region_id: zonal.orgUnit.regionId,
      };
    }
    const area = memberships.find((m) => m.designationLevel === "AREA_HEAD");
    if (area?.orgUnit.departmentId && area?.orgUnit.regionId) {
      return {
        department_id: area.orgUnit.departmentId,
        region_id: area.orgUnit.regionId,
      };
    }
    return {};
  }

  async function countVisibleEpcs(userId: string): Promise<number> {
    const [subtreeIds, scopingFilter] = await Promise.all([
      getSubtreeUserIds(userId),
      getEpcScopingFilter(userId),
    ]);
    return prisma.eventProposal.count({
      where: { created_by_id: { in: subtreeIds }, ...scopingFilter },
    });
  }

  const totalEpcs = await prisma.eventProposal.count();
  console.log(`\n   Total EPCs in DB: ${totalEpcs}`);
  console.log("   Visibility per user (tree × zone × dept filter):\n");

  const visibilityChecks = [
    { label: `[0]  ${users[0].first_name} — MD (HEAD)`, userId: users[0].id },
    { label: `[1]  ${users[1].first_name} — VP (HEAD)`, userId: users[1].id },
    {
      label: `[2]  ${users[2].first_name} — Marketing Head (DEPT_HEAD)`,
      userId: users[2].id,
    },
    {
      label: `[3]  ${users[3].first_name} — Mkt Zonal South (ZONAL_HEAD)`,
      userId: users[3].id,
    },
    {
      label: `[4]  ${users[4].first_name} — Mkt Zonal North (ZONAL_HEAD)`,
      userId: users[4].id,
    },
    {
      label: `[5]  ${users[5].first_name} — Mkt Area Chennai (AREA_HEAD)`,
      userId: users[5].id,
    },
    {
      label: `[9]  ${users[9].first_name} — Sales Head (DEPT_HEAD)`,
      userId: users[9].id,
    },
    {
      label: `[10] ${users[10].first_name} — Sales Zonal South (ZONAL_HEAD)`,
      userId: users[10].id,
    },
    {
      label: `[15] ${users[15].first_name} — Service Head (DEPT_HEAD)`,
      userId: users[15].id,
    },
    {
      label: `[16] ${users[16].first_name} — Svc Zonal South (ZONAL_HEAD)`,
      userId: users[16].id,
    },
    {
      label: `[7]  ${users[7].first_name} — Mkt Executive (MEMBER)`,
      userId: users[7].id,
    },
    {
      label: `[12] ${users[12].first_name} — Sales Rep (MEMBER)`,
      userId: users[12].id,
    },
  ];

  for (const { label, userId } of visibilityChecks) {
    const count = await countVisibleEpcs(userId);
    const bar = "█".repeat(Math.min(Math.floor(count / 2), 30));
    console.log(`   ${bar} ${String(count).padStart(4)} — ${label}`);
  }

  // Ordering assertion
  const mdCount = await countVisibleEpcs(users[0].id);
  const mktHdCount = await countVisibleEpcs(users[2].id);
  const mktZnCount = await countVisibleEpcs(users[3].id);
  const memberCount = await countVisibleEpcs(users[7].id);

  const orderOk =
    mdCount >= mktHdCount &&
    mktHdCount >= mktZnCount &&
    mktZnCount >= memberCount;
  console.log(
    `\n   ${orderOk ? "✅" : "❌"} Ordering: MD(${mdCount}) >= MktHead(${mktHdCount}) >= MktZonal(${mktZnCount}) >= Member(${memberCount})`,
  );

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║         ORG TREE SUMMARY  (v3 — multi-dept designation)             ║
╠══════════════════════════════════════════════════════════════════════╣
║  COMPANY-WIDE  (no dept, no zone — HEAD)                            ║
║    [0] ${users[0].first_name.padEnd(12)} MD              → ALL EPCs             ║
║    [1] ${users[1].first_name.padEnd(12)} VP              → ALL EPCs             ║
╠══════════════════════════════════════════════════════════════════════╣
║  MARKETING  (dept=Marketing)                                        ║
║    [2] ${users[2].first_name.padEnd(12)} Dept Head       → Mkt, all zones       ║
║    [3] ${users[3].first_name.padEnd(12)} Zonal South     → Mkt + South          ║
║    [4] ${users[4].first_name.padEnd(12)} Zonal North     → Mkt + North          ║
║    [5] ${users[5].first_name.padEnd(12)} Area Chennai    → Mkt + South          ║
║    [6] ${users[6].first_name.padEnd(12)} Area Delhi      → Mkt + North          ║
║    [7] ${users[7].first_name.padEnd(12)} Executive       → own EPCs only        ║
║    [8] ${users[8].first_name.padEnd(12)} Executive       → own EPCs only        ║
╠══════════════════════════════════════════════════════════════════════╣
║  SALES  (dept=Sales — flat, no Area Head tier)                      ║
║    [9]  ${users[9].first_name.padEnd(11)} Dept Head      → Sales, all zones     ║
║    [10] ${users[10].first_name.padEnd(11)} Zonal South   → Sales + South        ║
║    [11] ${users[11].first_name.padEnd(11)} Zonal North   → Sales + North        ║
║    [12] ${users[12].first_name.padEnd(11)} Sales Rep     → own EPCs only        ║
║    [13] ${users[13].first_name.padEnd(11)} Sales Rep     → own EPCs only        ║
║    [14] ${users[14].first_name.padEnd(11)} Sales Rep     → own EPCs only        ║
╠══════════════════════════════════════════════════════════════════════╣
║  SERVICE  (dept=Service — two Area Heads per zone)                  ║
║    [15] ${users[15].first_name.padEnd(11)} Dept Head     → Svc, all zones       ║
║    [16] ${users[16].first_name.padEnd(11)} Zonal South   → Svc + South          ║
║    [17] ${users[17].first_name.padEnd(11)} Zonal North   → Svc + North          ║
║    [18] ${users[18].first_name.padEnd(11)} Area Chennai  → Svc + South          ║
║    [19] ${users[19].first_name.padEnd(11)} Area Blore    → Svc + South          ║
║    [20] ${users[20].first_name.padEnd(11)} Area Delhi    → Svc + North          ║
║    [21] ${users[21].first_name.padEnd(11)} Technician    → own EPCs only        ║
║    [22] ${users[22].first_name.padEnd(11)} Technician    → own EPCs only        ║
║    [23] ${users[23].first_name.padEnd(11)} Technician    → own EPCs only        ║
║    [24] ${users[24].first_name.padEnd(11)} Technician    → own EPCs only        ║
╠══════════════════════════════════════════════════════════════════════╣
║  Password for all users: Password@123                               ║
╚══════════════════════════════════════════════════════════════════════╝`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

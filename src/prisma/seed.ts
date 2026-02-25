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
  console.log("🌱 Seeding database with Faker data...");

  /* -------------------- CLEAN RBAC -------------------- */

  await prisma.userAppProfile.deleteMany();
  await prisma.profilePermission.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.module.deleteMany();
  await prisma.workspaceApp.deleteMany();
  await prisma.workspaceUser.deleteMany();
  await prisma.app.deleteMany();
  await prisma.workspace.deleteMany();

  /* -------------------- CLEAN BUSINESS DATA -------------------- */

  await prisma.eventProposal.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.region.deleteMany();
  await prisma.department.deleteMany();
  await prisma.eventScale.deleteMany();
  await prisma.budgetMaster.deleteMany();
  await prisma.eventName.deleteMany();
  await prisma.user.deleteMany();

  /* -------------------- WORKSPACE -------------------- */

  const workspace = await prisma.workspace.create({
    data: { name: "Tata Hitachi Workspace" },
  });

  /* -------------------- APP -------------------- */

  const eventApp = await prisma.app.create({
    data: {
      key: "MAP",
      name: MARKETING_ACTIVITY_PLANNER,
    },
  });

  await prisma.workspaceApp.create({
    data: {
      workspaceId: workspace.id,
      appId: eventApp.id,
    },
  });

  /* -------------------- MODULES -------------------- */

  const proposalModule = await prisma.module.create({
    data: {
      key: "EPC",
      name: EVENT_PLANNING_CALENDAR,
      appId: eventApp.id,
    },
  });

  const approvalModule = await prisma.module.create({
    data: {
      key: "approval",
      name: "Event Approval",
      appId: eventApp.id,
    },
  });

  const reportModule = await prisma.module.create({
    data: {
      key: "report",
      name: "Event Report",
      appId: eventApp.id,
    },
  });

  /* -------------------- PROFILES -------------------- */

  const adminRole = await prisma.profile.create({
    data: {
      // name: "Admin",
      workspaceId: workspace.id,
      moduleId: proposalModule.id,
      permissions: {
        create: [{ permission: "read" }, { permission: "write" }],
      },
    },
  });

  // const editorRole = await prisma.profile.create({
  //   data: {
  //     // name: "Editor",
  //     workspaceId: workspace.id,
  //     moduleId: proposalModule.id,
  //     permissions: {
  //       create: [{ permission: "read" }, { permission: "write" }],
  //     },
  //   },
  // });

  // const viewerRole = await prisma.profile.create({
  //   data: {
  //     // name: "Viewer",
  //     workspaceId: workspace.id,
  //     moduleId: proposalModule.id,
  //     permissions: {
  //       create: [{ permission: "read" }],
  //     },
  //   },
  // });

  const approvalManagerRole = await prisma.profile.create({
    data: {
      // name: "Approval Manager",
      workspaceId: workspace.id,
      moduleId: approvalModule.id,
      permissions: {
        create: [{ permission: "read" }, { permission: "write" }],
      },
    },
  });

  const reportViewerRole = await prisma.profile.create({
    data: {
      // name: "Report Viewer",
      workspaceId: workspace.id,
      moduleId: reportModule.id,
      permissions: {
        create: [{ permission: "read" }],
      },
    },
  });

  /* -------------------- USERS -------------------- */

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

  /* -------------------- WORKSPACE MEMBERSHIP -------------------- */

  for (let i = 0; i < users.length; i++) {
    await prisma.workspaceUser.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        isSuperAdmin: i === 0,
      },
    });
  }

  /* -------------------- PROFILE ASSIGNMENT -------------------- */

  await prisma.userAppProfile.create({
    data: {
      userId: users[0].id,
      workspaceId: workspace.id,
      appId: eventApp.id,
      profileId: adminRole.id,
    },
  });

  // for (let i = 1; i <= 3; i++) {
  //   await prisma.userAppProfile.create({
  //     data: {
  //       userId: users[i].id,
  //       workspaceId: workspace.id,
  //       appId: eventApp.id,
  //       profileId: editorRole.id,
  //     },
  //   });
  // }

  for (let i = 1; i <= 5; i++) {
    await prisma.userAppProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        appId: eventApp.id,
        profileId: approvalManagerRole.id,
      },
    });
  }

  for (let i = 6; i < users.length; i++) {
    await prisma.userAppProfile.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        appId: eventApp.id,
        profileId: reportViewerRole.id,
      },
    });
  }

  /* -------------------- MASTER DATA -------------------- */

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

  /* -------------------- EVENT PROPOSALS -------------------- */

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

  console.log("✅ Seeding completed successfully");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

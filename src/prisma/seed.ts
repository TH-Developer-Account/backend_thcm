import { prisma } from "../config/prisma";
import { faker } from "@faker-js/faker";

async function main() {
  console.log("🌱 Seeding database with Faker data...");

  /* -------------------- CLEAN RBAC FIRST -------------------- */

  await prisma.userAppRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
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
    data: { name: "Main Workspace" },
  });

  /* -------------------- APP -------------------- */

  const eventApp = await prisma.app.create({
    data: {
      key: "event",
      name: "Event Proposal System",
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
      key: "proposal",
      name: "Event Proposal",
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

  /* -------------------- ROLES -------------------- */

  const adminRole = await prisma.role.create({
    data: {
      name: "Admin",
      workspaceId: workspace.id,
      moduleId: proposalModule.id,
      permissions: {
        create: [
          { permission: "read" },
          { permission: "create" },
          { permission: "update" },
          { permission: "delete" },
        ],
      },
    },
  });

  const editorRole = await prisma.role.create({
    data: {
      name: "Proposal Editor",
      workspaceId: workspace.id,
      moduleId: proposalModule.id,
      permissions: {
        create: [
          { permission: "read" },
          { permission: "create" },
          { permission: "update" },
        ],
      },
    },
  });

  const viewerRole = await prisma.role.create({
    data: {
      name: "Proposal Viewer",
      workspaceId: workspace.id,
      moduleId: proposalModule.id,
      permissions: {
        create: [{ permission: "read" }],
      },
    },
  });

  const approvalManagerRole = await prisma.role.create({
    data: {
      name: "Approval Manager",
      workspaceId: workspace.id,
      moduleId: approvalModule.id,
      permissions: {
        create: [{ permission: "read" }, { permission: "update" }],
      },
    },
  });

  const reportViewerRole = await prisma.role.create({
    data: {
      name: "Report Viewer",
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

  /* -------------------- ROLE ASSIGNMENT -------------------- */

  await prisma.userAppRole.create({
    data: {
      userId: users[0].id,
      workspaceId: workspace.id,
      appId: eventApp.id,
      roleId: adminRole.id,
    },
  });

  for (let i = 1; i <= 3; i++) {
    await prisma.userAppRole.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        appId: eventApp.id,
        roleId: editorRole.id,
      },
    });
  }

  for (let i = 4; i <= 5; i++) {
    await prisma.userAppRole.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        appId: eventApp.id,
        roleId: approvalManagerRole.id,
      },
    });
  }

  for (let i = 6; i < users.length; i++) {
    await prisma.userAppRole.create({
      data: {
        userId: users[i].id,
        workspaceId: workspace.id,
        appId: eventApp.id,
        roleId: viewerRole.id,
      },
    });
  }

  /* -------------------- BUSINESS MASTER DATA -------------------- */

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

  const regions = await Promise.all(
    ["North", "South", "East", "West"].map((name) =>
      prisma.region.create({
        data: {
          region_code: name.toUpperCase(),
          region_name: `${name} Region`,
        },
      }),
    ),
  );

  const branches = [];
  for (const region of regions) {
    for (let i = 0; i < 3; i++) {
      branches.push(
        await prisma.branch.create({
          data: {
            branch_code: `BR-${region.region_code}-${i + 1}`,
            branch_name: faker.location.city(),
            region_id: region.id,
          },
        }),
      );
    }
  }

  const eventScales = await Promise.all([
    prisma.eventScale.create({
      data: {
        scale_code: "SMALL",
        scale_name: "Small Event",
        max_budget: 100000,
      },
    }),
    prisma.eventScale.create({
      data: {
        scale_code: "MEDIUM",
        scale_name: "Medium Event",
        max_budget: 500000,
      },
    }),
    prisma.eventScale.create({
      data: {
        scale_code: "LARGE",
        scale_name: "Large Event",
        max_budget: 2000000,
      },
    }),
  ]);

  const budgetMasters = await Promise.all(
    ["2024-2025", "2025-2026"].map((fy) =>
      prisma.budgetMaster.create({
        data: {
          financial_year: fy,
          total_budget: faker.number.int({ min: 5_000_000, max: 20_000_000 }),
        },
      }),
    ),
  );

  const eventNames = await Promise.all(
    ["Conference", "Workshop", "Meetup", "Seminar"].map((type) =>
      prisma.eventName.create({
        data: {
          event_code: type.toUpperCase().slice(0, 5),
          description: type,
        },
      }),
    ),
  );

  for (let i = 0; i < 50; i++) {
    const department = faker.helpers.arrayElement(departments);
    const region = faker.helpers.arrayElement(regions);
    const branch = faker.helpers.arrayElement(
      branches.filter((b) => b.region_id === region.id),
    );
    const scale = faker.helpers.arrayElement(eventScales);
    const budget = faker.helpers.arrayElement(budgetMasters);
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

import { prisma } from "../config/prisma";
import { faker } from "@faker-js/faker";

async function main() {
  console.log("🌱 Seeding database with Faker data...");

  /* -------------------- CLEAN DB (OPTIONAL) -------------------- */
  await prisma.user.deleteMany();
  await prisma.eventProposal.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.region.deleteMany();
  await prisma.department.deleteMany();
  await prisma.eventScale.deleteMany();
  await prisma.budgetMaster.deleteMany();
  await prisma.eventName.deleteMany();

  /* -------------------- USERS -------------------- */

  const users = await Promise.all(
    [
      {
        first_name: "Amit",
        last_name: "Sharma",
        email: "amit.sharma@company.com",
        phone_number: "9876543210",
      },
      {
        first_name: "Neha",
        last_name: "Verma",
        email: "neha.verma@company.com",
        phone_number: "9812345678",
      },
      {
        first_name: "Rahul",
        last_name: "Mehta",
        email: "rahul.mehta@company.com",
        phone_number: "9898989898",
      },
      {
        first_name: "Priya",
        last_name: "Iyer",
        email: "priya.iyer@company.com",
        phone_number: "9823456789",
      },
      {
        first_name: "Sandeep",
        last_name: "Kumar",
        email: "sandeep.kumar@company.com",
        phone_number: "9765432109",
      },
      {
        first_name: "Ananya",
        last_name: "Gupta",
        email: "ananya.gupta@company.com",
        phone_number: "9753124680",
      },
    ].map((user) =>
      prisma.user.create({
        data: {
          ...user,
          password: "Password@123",
          is_active: true,
          is_default_login: true,
        },
      }),
    ),
  );

  /* -------------------- DEPARTMENTS -------------------- */
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

  /* -------------------- REGIONS -------------------- */
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

  /* -------------------- BRANCHES -------------------- */
  const branches = [];
  for (const region of regions) {
    for (let i = 0; i < 3; i++) {
      branches.push(
        await prisma.branch.create({
          data: {
            branch_code: `BR-${region.region_code}-${i + 1}`,
            branch_name: `${faker.location.city()} Branch`,
            region_id: region.id,
          },
        }),
      );
    }
  }

  /* -------------------- EVENT SCALES -------------------- */
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

  /* -------------------- BUDGET MASTER -------------------- */
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

  /* -------------------- EVENT NAMES -------------------- */
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

  /* -------------------- EVENT PROPOSALS -------------------- */
  const TOTAL_EVENTS = 50; // 🔥 Change this number anytime

  for (let i = 0; i < TOTAL_EVENTS; i++) {
    const department = faker.helpers.arrayElement(departments);
    const region = faker.helpers.arrayElement(regions);
    const branch = faker.helpers.arrayElement(
      branches.filter((b) => b.region_id === region.id),
    );
    const scale = faker.helpers.arrayElement(eventScales);
    const budget = faker.helpers.arrayElement(budgetMasters);
    const eventName = faker.helpers.arrayElement(eventNames);

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
        status: faker.helpers.arrayElement(["DRAFT", "SUBMITTED", "APPROVED"]),
        created_by: faker.internet.email(),
        updated_by: faker.internet.email(),
        department_id: department.id,
        region_id: region.id,
        branch_id: branch.id,
        event_scale_id: scale.id,
        budget_master_id: budget.id,
        event_name_id: eventName.id,
      },
    });
  }

  const RANDOM_USERS = 10;

  for (let i = 0; i < RANDOM_USERS; i++) {
    await prisma.user.create({
      data: {
        first_name: faker.person.firstName(),
        last_name: faker.person.lastName(),
        email: faker.internet.email().toLowerCase(),
        phone_number: `9${faker.string.numeric(9)}`,
        password: "Password@123",
        is_active: true,
        is_default_login: true,
      },
    });
  }

  console.log("✅ Faker seeding completed successfully");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

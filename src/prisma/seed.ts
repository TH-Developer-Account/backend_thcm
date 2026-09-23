import { prisma } from "@shared/config/prisma";
import { faker } from "@faker-js/faker";
import {
  MARKETING_ACTIVITY_PLANNER,
  VENDOR_ONBOARDING,
  MEDICAL_CLAIM,
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
  await prisma.importExportLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.vendorOnboardingDocument.deleteMany();
  await prisma.vendorOnboarding.deleteMany();
  await prisma.medicalClaim.deleteMany();
  await prisma.medicalClaimBill.deleteMany();
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
  await prisma.accessToken.deleteMany();
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
  const mediclaimApp = await prisma.app.create({
    data: { key: "MEDICAL_CLAIM", name: MEDICAL_CLAIM },
  });

  await prisma.workspaceApp.createMany({
    data: [
      { workspaceId: workspace.id, appId: mapApp.id },
      { workspaceId: workspace.id, appId: vendorApp.id },
      { workspaceId: workspace.id, appId: mediclaimApp.id },
    ],
  });
  console.log("✅ Apps enabled: MAP, Vendor Onboarding");

  await prisma.module.create({
    data: { key: "EPC", name: EVENT_PLANNING_CALENDAR, appId: mapApp.id },
  });
  await prisma.module.create({
    data: { key: "EPF", name: "Event Proposal Form", appId: mapApp.id },
  });
  await prisma.module.create({
    data: { key: "CRF", name: "Customer Response Form", appId: mapApp.id },
  });

  await prisma.module.create({
    data: {
      key: "VENDOR_INITIATION",
      name: "Vendor Initiation",
      appId: vendorApp.id,
    },
  });
  await prisma.module.create({
    data: {
      key: "MEDICAL_CLAIM_INITIATION",
      name: "Medical Claim Initiation",
      appId: mediclaimApp.id,
    },
  });

  console.log("✅ Modules created for MAP and Vendor Onboarding");

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

  await prisma.branch.createMany({ data: branchData, skipDuplicates: true });

  await prisma.budgetMaster.createMany({
    data: budgetCodeData,
    skipDuplicates: true,
  });

  await prisma.eventName.createMany({
    data: eventNameData,
    skipDuplicates: true,
  });

  await prisma.productMaster.createMany({
    data: products as ProductMasterCreateManyInput[],
    skipDuplicates: true,
  });

  console.log("✅ Products created");
  console.log("\n🎉 Seeding completed successfully\n");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

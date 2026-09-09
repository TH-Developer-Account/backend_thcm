/*
  Warnings:

  - You are about to drop the column `created_at` on the `Branch` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `Branch` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `BudgetMaster` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `BudgetMaster` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `Department` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `Department` table. All the data in the column will be lost.
  - You are about to drop the column `search_vector` on the `EventProposal` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `EventScale` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `EventScale` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `Module` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `Module` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `Profile` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `Profile` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `Region` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `Region` table. All the data in the column will be lost.
  - You are about to drop the column `assignedAt` on the `UserProfile` table. All the data in the column will be lost.
  - You are about to drop the column `assignedBy` on the `UserProfile` table. All the data in the column will be lost.
  - You are about to drop the column `enabledAt` on the `WorkspaceApp` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('ALL', 'ANY', 'QUORUM');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('IN_PROGRESS', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- DropIndex
DROP INDEX "Module_appId_idx";

-- DropIndex
DROP INDEX "Profile_workspaceId_idx";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_idx";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_moduleId_idx";

-- DropIndex
DROP INDEX "UserProfile_userId_workspaceId_idx";

-- DropIndex
DROP INDEX "UserProfile_workspaceId_profileId_idx";

-- DropIndex
DROP INDEX "WorkspaceApp_workspaceId_idx";

-- AlterTable
ALTER TABLE "App" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Branch" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "BudgetMaster" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "Department" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "EventProposal" DROP COLUMN "search_vector";

-- AlterTable
ALTER TABLE "EventScale" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "Module" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "Profile" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "Region" DROP COLUMN "created_at",
DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "UserProfile" DROP COLUMN "assignedAt",
DROP COLUMN "assignedBy";

-- AlterTable
ALTER TABLE "WorkspaceApp" DROP COLUMN "enabledAt";

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "minBudget" DECIMAL(65,30) NOT NULL,
    "maxBudget" DECIMAL(65,30) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateStage" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "stageOrder" INTEGER NOT NULL,
    "strategy" "StrategyType" NOT NULL,
    "minApprovals" INTEGER,

    CONSTRAINT "TemplateStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateApprover" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TemplateApprover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventProposalId" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "currentStage" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageInstance" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stageOrder" INTEGER NOT NULL,
    "strategy" "StrategyType" NOT NULL,
    "minApprovals" INTEGER,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "StageInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "actedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TemplateStage_templateId_stageOrder_key" ON "TemplateStage"("templateId", "stageOrder");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateApprover_stageId_userId_key" ON "TemplateApprover"("stageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_eventProposalId_key" ON "WorkflowInstance"("eventProposalId");

-- CreateIndex
CREATE UNIQUE INDEX "StageInstance_workflowId_stageOrder_key" ON "StageInstance"("workflowId", "stageOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_stageId_approverId_key" ON "Approval"("stageId", "approverId");

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateStage" ADD CONSTRAINT "TemplateStage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateApprover" ADD CONSTRAINT "TemplateApprover_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "TemplateStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateApprover" ADD CONSTRAINT "TemplateApprover_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_eventProposalId_fkey" FOREIGN KEY ("eventProposalId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageInstance" ADD CONSTRAINT "StageInstance_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "StageInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

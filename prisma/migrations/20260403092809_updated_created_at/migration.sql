/*
  Warnings:

  - Added the required column `updated_at` to the `Branch` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `BudgetMaster` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `Department` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `EventScale` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `Region` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "BudgetMaster" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "EventProposal" ADD COLUMN     "search_vector" tsvector;

-- AlterTable
ALTER TABLE "EventScale" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Module" ADD COLUMN     "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "assignedBy" TEXT;

-- AlterTable
ALTER TABLE "WorkspaceApp" ADD COLUMN     "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Profile_workspaceId_idx" ON "Profile"("workspaceId");

-- CreateIndex
CREATE INDEX "ProfilePermission_profileId_moduleId_idx" ON "ProfilePermission"("profileId", "moduleId");

-- CreateIndex
CREATE INDEX "UserProfile_userId_workspaceId_profileId_idx" ON "UserProfile"("userId", "workspaceId", "profileId");

-- CreateIndex
CREATE INDEX "WorkspaceApp_workspaceId_idx" ON "WorkspaceApp"("workspaceId");

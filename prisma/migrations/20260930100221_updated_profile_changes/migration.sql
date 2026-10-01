/*
  Warnings:

  - You are about to drop the column `appId` on the `ProfilePermission` table. All the data in the column will be lost.
  - You are about to drop the column `scope` on the `ProfilePermission` table. All the data in the column will be lost.
  - The primary key for the `UserProfile` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `assignedBy` on the `UserProfile` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `UserProfile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[workspaceId,appId,name]` on the table `Profile` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[id,appId]` on the table `Profile` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[profileId,moduleId,action]` on the table `ProfilePermission` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `appId` to the `Profile` table without a default value. This is not possible if the table is not empty.
  - Made the column `moduleId` on table `ProfilePermission` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `appId` to the `UserProfile` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_appId_fkey";

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "UserProfile" DROP CONSTRAINT "UserProfile_profileId_fkey";

-- DropIndex
DROP INDEX "Profile_workspaceId_idx";

-- DropIndex
DROP INDEX "Profile_workspaceId_name_key";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_action_appId_key";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_action_moduleId_key";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_appId_idx";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_moduleId_idx";

-- DropIndex
DROP INDEX "UserProfile_userId_workspaceId_profileId_idx";

-- DropIndex
DROP INDEX "UserProfile_userId_workspaceId_profileId_key";

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "appId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ProfilePermission" DROP COLUMN "appId",
DROP COLUMN "scope",
ALTER COLUMN "moduleId" SET NOT NULL;

-- AlterTable
ALTER TABLE "UserProfile" DROP CONSTRAINT "UserProfile_pkey",
DROP COLUMN "assignedBy",
DROP COLUMN "id",
ADD COLUMN     "appId" TEXT NOT NULL,
ADD COLUMN     "assignedById" TEXT,
ADD CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("userId", "workspaceId", "appId");

-- DropEnum
DROP TYPE "ScopeType";

-- CreateTable
CREATE TABLE "AppAdministrator" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppAdministrator_pkey" PRIMARY KEY ("workspaceId","userId","appId")
);

-- CreateIndex
CREATE INDEX "AppAdministrator_workspaceId_appId_idx" ON "AppAdministrator"("workspaceId", "appId");

-- CreateIndex
CREATE INDEX "Profile_workspaceId_appId_idx" ON "Profile"("workspaceId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_workspaceId_appId_name_key" ON "Profile"("workspaceId", "appId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_id_appId_key" ON "Profile"("id", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePermission_profileId_moduleId_action_key" ON "ProfilePermission"("profileId", "moduleId", "action");

-- CreateIndex
CREATE INDEX "UserProfile_workspaceId_profileId_idx" ON "UserProfile"("workspaceId", "profileId");

-- AddForeignKey
ALTER TABLE "AppAdministrator" ADD CONSTRAINT "AppAdministrator_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAdministrator" ADD CONSTRAINT "AppAdministrator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAdministrator" ADD CONSTRAINT "AppAdministrator_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAdministrator" ADD CONSTRAINT "AppAdministrator_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_profileId_appId_fkey" FOREIGN KEY ("profileId", "appId") REFERENCES "Profile"("id", "appId") ON DELETE RESTRICT ON UPDATE CASCADE;

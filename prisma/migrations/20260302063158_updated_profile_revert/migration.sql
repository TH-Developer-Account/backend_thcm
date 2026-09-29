/*
  Warnings:

  - A unique constraint covering the columns `[profileId,action,scopeType,appId,moduleId]` on the table `ProfilePermission` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ScopeType" ADD VALUE 'APP';

-- DropIndex
DROP INDEX "ProfilePermission_profileId_action_scopeType_moduleId_key";

-- AlterTable
ALTER TABLE "ProfilePermission" ADD COLUMN     "appId" TEXT;

-- CreateIndex
CREATE INDEX "ProfilePermission_profileId_appId_idx" ON "ProfilePermission"("profileId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePermission_profileId_action_scopeType_appId_moduleId_key" ON "ProfilePermission"("profileId", "action", "scopeType", "appId", "moduleId");

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE SET NULL ON UPDATE CASCADE;

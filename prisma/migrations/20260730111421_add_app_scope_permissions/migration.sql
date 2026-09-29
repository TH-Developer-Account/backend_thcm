/*
  Warnings:

  - A unique constraint covering the columns `[profileId,action,appId]` on the table `ProfilePermission` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ScopeType" ADD VALUE 'APP';

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_moduleId_fkey";

-- AlterTable
ALTER TABLE "ProfilePermission" ADD COLUMN     "appId" TEXT,
ADD COLUMN     "scope" "ScopeType" NOT NULL DEFAULT 'MODULE',
ALTER COLUMN "moduleId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ProfilePermission_profileId_appId_idx" ON "ProfilePermission"("profileId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePermission_profileId_action_appId_key" ON "ProfilePermission"("profileId", "action", "appId");

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProfilePermission"
  ADD CONSTRAINT "scope_matches_exactly_one_fk"
  CHECK (
    (scope = 'MODULE' AND "moduleId" IS NOT NULL AND "appId" IS NULL) OR
    (scope = 'APP'    AND "appId" IS NOT NULL    AND "moduleId" IS NULL)
  );
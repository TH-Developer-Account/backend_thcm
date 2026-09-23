/*
  Warnings:

  - The values [APP] on the enum `ScopeType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `appId` on the `ProfilePermission` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[profileId,action,scopeType,moduleId]` on the table `ProfilePermission` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ScopeType_new" AS ENUM ('WORKSPACE', 'MODULE');
ALTER TABLE "ProfilePermission" ALTER COLUMN "scopeType" TYPE "ScopeType_new" USING ("scopeType"::text::"ScopeType_new");
ALTER TYPE "ScopeType" RENAME TO "ScopeType_old";
ALTER TYPE "ScopeType_new" RENAME TO "ScopeType";
DROP TYPE "public"."ScopeType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_appId_fkey";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_action_scopeType_appId_moduleId_key";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_appId_idx";

-- AlterTable
ALTER TABLE "ProfilePermission" DROP COLUMN "appId";

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePermission_profileId_action_scopeType_moduleId_key" ON "ProfilePermission"("profileId", "action", "scopeType", "moduleId");

/*
  Warnings:

  - You are about to drop the column `appId` on the `ProfilePermission` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('MODULE');

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_appId_fkey";

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_moduleId_fkey";

-- DropIndex
DROP INDEX "ProfilePermission_profileId_appId_idx";

-- AlterTable
ALTER TABLE "ProfilePermission" DROP COLUMN "appId";

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

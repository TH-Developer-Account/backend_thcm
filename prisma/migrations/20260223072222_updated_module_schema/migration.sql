/*
  Warnings:

  - You are about to drop the column `name` on the `Profile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[appId,key]` on the table `Module` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[workspaceId,moduleId]` on the table `Profile` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Profile_workspaceId_moduleId_name_key";

-- AlterTable
ALTER TABLE "Profile" DROP COLUMN "name";

-- CreateIndex
CREATE UNIQUE INDEX "Module_appId_key_key" ON "Module"("appId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_workspaceId_moduleId_key" ON "Profile"("workspaceId", "moduleId");

/*
  Warnings:

  - You are about to drop the `Profile` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProfilePermission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserAppProfile` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Profile" DROP CONSTRAINT "Profile_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "Profile" DROP CONSTRAINT "Profile_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ProfilePermission" DROP CONSTRAINT "ProfilePermission_profileId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppProfile" DROP CONSTRAINT "UserAppProfile_appId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppProfile" DROP CONSTRAINT "UserAppProfile_profileId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppProfile" DROP CONSTRAINT "UserAppProfile_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppProfile" DROP CONSTRAINT "UserAppProfile_workspaceId_fkey";

-- DropIndex
DROP INDEX "WorkspaceApp_workspaceId_appId_key";

-- DropTable
DROP TABLE "Profile";

-- DropTable
DROP TABLE "ProfilePermission";

-- DropTable
DROP TABLE "UserAppProfile";

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleId" TEXT,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permission" "PermissionAction" NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","workspaceId","roleId")
);

-- CreateIndex
CREATE INDEX "Role_workspaceId_moduleId_idx" ON "Role"("workspaceId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_workspaceId_moduleId_name_key" ON "Role"("workspaceId", "moduleId", "name");

-- CreateIndex
CREATE INDEX "UserRole_userId_workspaceId_idx" ON "UserRole"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/*
  Warnings:

  - You are about to drop the `Role` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RolePermission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserAppRole` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Role" DROP CONSTRAINT "Role_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "Role" DROP CONSTRAINT "Role_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppRole" DROP CONSTRAINT "UserAppRole_appId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppRole" DROP CONSTRAINT "UserAppRole_roleId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppRole" DROP CONSTRAINT "UserAppRole_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserAppRole" DROP CONSTRAINT "UserAppRole_workspaceId_fkey";

-- DropIndex
DROP INDEX "event_proposal_search_idx";

-- DropTable
DROP TABLE "Role";

-- DropTable
DROP TABLE "RolePermission";

-- DropTable
DROP TABLE "UserAppRole";

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleId" TEXT,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilePermission" (
    "profileId" TEXT NOT NULL,
    "permission" "PermissionAction" NOT NULL,

    CONSTRAINT "ProfilePermission_pkey" PRIMARY KEY ("profileId","permission")
);

-- CreateTable
CREATE TABLE "UserAppProfile" (
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,

    CONSTRAINT "UserAppProfile_pkey" PRIMARY KEY ("userId","workspaceId","appId")
);

-- CreateIndex
CREATE INDEX "Profile_workspaceId_moduleId_idx" ON "Profile"("workspaceId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_workspaceId_moduleId_name_key" ON "Profile"("workspaceId", "moduleId", "name");

-- CreateIndex
CREATE INDEX "UserAppProfile_userId_workspaceId_idx" ON "UserAppProfile"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePermission" ADD CONSTRAINT "ProfilePermission_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAppProfile" ADD CONSTRAINT "UserAppProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAppProfile" ADD CONSTRAINT "UserAppProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAppProfile" ADD CONSTRAINT "UserAppProfile_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAppProfile" ADD CONSTRAINT "UserAppProfile_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/*
  Warnings:

  - A unique constraint covering the columns `[workspaceId,appId]` on the table `WorkspaceApp` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceApp_workspaceId_appId_key" ON "WorkspaceApp"("workspaceId", "appId");

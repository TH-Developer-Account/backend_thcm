-- CreateEnum
CREATE TYPE "OrgMemberRole" AS ENUM ('MANAGER', 'MEMBER');

-- CreateTable
CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUnitMember" (
    "id" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUnitMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUnitClosure" (
    "ancestorId" TEXT NOT NULL,
    "descendantId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "OrgUnitClosure_pkey" PRIMARY KEY ("ancestorId","descendantId")
);

-- CreateIndex
CREATE INDEX "OrgUnit_workspaceId_idx" ON "OrgUnit"("workspaceId");

-- CreateIndex
CREATE INDEX "OrgUnit_parentId_idx" ON "OrgUnit"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnit_workspaceId_name_key" ON "OrgUnit"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "OrgUnitMember_userId_idx" ON "OrgUnitMember"("userId");

-- CreateIndex
CREATE INDEX "OrgUnitMember_orgUnitId_idx" ON "OrgUnitMember"("orgUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnitMember_orgUnitId_userId_key" ON "OrgUnitMember"("orgUnitId", "userId");

-- CreateIndex
CREATE INDEX "OrgUnitClosure_ancestorId_idx" ON "OrgUnitClosure"("ancestorId");

-- CreateIndex
CREATE INDEX "OrgUnitClosure_descendantId_idx" ON "OrgUnitClosure"("descendantId");

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitMember" ADD CONSTRAINT "OrgUnitMember_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitMember" ADD CONSTRAINT "OrgUnitMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitClosure" ADD CONSTRAINT "OrgUnitClosure_ancestorId_fkey" FOREIGN KEY ("ancestorId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitClosure" ADD CONSTRAINT "OrgUnitClosure_descendantId_fkey" FOREIGN KEY ("descendantId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

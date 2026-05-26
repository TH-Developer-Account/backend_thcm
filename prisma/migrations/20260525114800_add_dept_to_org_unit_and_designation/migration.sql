-- CreateEnum
CREATE TYPE "DesignationLevel" AS ENUM ('HEAD', 'DEPT_HEAD', 'ZONAL_HEAD', 'AREA_HEAD', 'MEMBER');

-- AlterTable
ALTER TABLE "OrgUnit" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "regionId" TEXT;

-- CreateIndex
CREATE INDEX "OrgUnit_regionId_idx" ON "OrgUnit"("regionId");

-- CreateIndex
CREATE INDEX "OrgUnit_departmentId_idx" ON "OrgUnit"("departmentId");

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
